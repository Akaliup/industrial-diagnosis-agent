#!/bin/bash

# Root-side container identity helpers. This file is copied into the image and
# sourced from the fixed /app/session-permissions.sh path by entrypoint.sh.
# Nothing here accepts a path or helper override from the runtime env.

INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE=unconfigured
INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_UID=
INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_GID=
INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID=

industrial_diagnosis_permission_error() {
  printf 'industrial-diagnosis: %s\n' "$1" >&2
}

industrial_diagnosis_permission_fatal() {
  industrial_diagnosis_permission_error "$1"
  return 1
}

industrial_diagnosis_valid_nonroot_id() {
  local value="$1"
  case "$value" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$value" -gt 0 ] 2>/dev/null && [ "$value" -le 2147483647 ] 2>/dev/null
}

industrial_diagnosis_write_runtime_ids() {
  local runtime_user="$1"
  local runtime_uid="$2"
  local runtime_gid="$3"
  local passwd_file=/etc/passwd
  local temporary

  temporary=$(mktemp /etc/industrial-diagnosis-passwd.XXXXXX) || return 1
  if ! awk -F: -v OFS=: -v user="$runtime_user" \
    -v uid="$runtime_uid" -v gid="$runtime_gid" '
      $1 == user { $3 = uid; $4 = gid; found = 1 }
      { print }
      END { if (!found) exit 42 }
    ' "$passwd_file" > "$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0644 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" "$passwd_file"
}

industrial_diagnosis_configure_node_identity() {
  local runtime_user=node
  local mode="${INDUSTRIAL_DIAGNOSIS_HOST_IDENTITY_MODE:-unknown}"
  local requested_uid="${INDUSTRIAL_DIAGNOSIS_HOST_UID:-}"
  local requested_gid="${INDUSTRIAL_DIAGNOSIS_HOST_GID:-}"
  local current_uid current_gid existing_name target_gid

  current_uid=$(id -u "$runtime_user") || return 1
  current_gid=$(id -g "$runtime_user") || return 1
  case "$mode" in
    direct)
      if ! industrial_diagnosis_valid_nonroot_id "$requested_uid"; then
        industrial_diagnosis_permission_fatal \
          "direct identity mode requires a validated non-root host uid"
        return 1
      fi
      target_gid="$current_gid"
      if [ -n "$requested_gid" ]; then
        if ! industrial_diagnosis_valid_nonroot_id "$requested_gid"; then
          industrial_diagnosis_permission_fatal \
            "direct identity mode received an invalid host gid"
          return 1
        fi
        target_gid="$requested_gid"
      fi
      if [ "$requested_uid" != "$current_uid" ]; then
        existing_name=$(getent passwd "$requested_uid" | cut -d: -f1 || true)
        if [ -n "$existing_name" ]; then
          industrial_diagnosis_permission_fatal \
            "host uid $requested_uid collides with image account $existing_name"
          return 1
        fi
      fi
      if [ "$target_gid" != "$current_gid" ]; then
        existing_name=$(getent group "$target_gid" | cut -d: -f1 || true)
        if [ -n "$existing_name" ]; then
          industrial_diagnosis_permission_error \
            "host gid $target_gid collides with image group $existing_name; keeping node gid $current_gid"
          target_gid="$current_gid"
        elif ! groupmod --gid "$target_gid" "$runtime_user"; then
          industrial_diagnosis_permission_fatal \
            "could not align the node group with host gid $target_gid"
          return 1
        fi
      fi
      if [ "$requested_uid" != "$current_uid" ] || [ "$target_gid" != "$current_gid" ]; then
        if ! industrial_diagnosis_write_runtime_ids "$runtime_user" "$requested_uid" "$target_gid"; then
          industrial_diagnosis_permission_fatal "could not update the node passwd identity"
          return 1
        fi
      fi
      INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE=direct
      INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_UID="$requested_uid"
      INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_GID="$target_gid"
      chown "$requested_uid:$target_gid" /home/node
      ;;
    rootless)
      # Rootless Docker maps container uid 0 to the daemon/service uid. The
      # mapping is verified against host-created bind roots before it is used.
      INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE=rootless
      INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_UID="$current_uid"
      INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_GID="$current_gid"
      ;;
    host-root)
      # Host uid 0 can read node-owned 0600 files. Keep the agent non-root and
      # normalize only explicitly authorized writable mounts.
      INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE=host-root
      INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_UID="$current_uid"
      INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_GID="$current_gid"
      ;;
    virtualized)
      # Preserve Docker Desktop's established node-owned bind semantics, but
      # never grant group/other access. Real Mac/Windows smoke is required.
      INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE=virtualized
      INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_UID="$current_uid"
      INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_GID="$current_gid"
      ;;
    userns)
      industrial_diagnosis_permission_fatal \
        "rootful userns-remap has no safe host/session identity bridge; refusing to start"
      return 1
      ;;
    unknown | *)
      industrial_diagnosis_permission_fatal \
        "container identity could not be determined safely; refusing to start"
      return 1
      ;;
  esac
  export INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE
  export INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_UID INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_GID
}

industrial_diagnosis_prepare_mounted_paths() {
  case "$INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE" in
    direct)
      /usr/local/bin/node /app/session-permissions-watcher.mjs \
        --normalize-direct-mount-roots
      ;;
    rootless)
      # The watcher performs one owner/group/mode transaction before node runs.
      ;;
    host-root | virtualized)
      /usr/local/bin/node /app/session-permissions-watcher.mjs \
        --normalize-node-owned-mounts
      ;;
    *)
      industrial_diagnosis_permission_fatal "mount preparation attempted before safe identity setup"
      return 1
      ;;
  esac
}

industrial_diagnosis_prepare_generated_path() {
  local generated_key="$1"
  case "$generated_key" in
    npm-global | skills | dist | chromium) ;;
    *)
      industrial_diagnosis_permission_fatal "unknown generated permission root"
      return 1
      ;;
  esac
  case "$INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE" in
    direct | host-root | virtualized)
      /usr/local/bin/node /app/session-permissions-watcher.mjs \
        "--normalize-generated=$generated_key"
      ;;
    rootless)
      case "$generated_key" in
        dist | chromium)
          /usr/local/bin/node /app/session-permissions-watcher.mjs \
            "--normalize-generated=$generated_key"
          ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

# These locals intentionally shadow persisted root-control variables.
# shellcheck disable=SC2034
industrial_diagnosis_source_runtime_env() {
  # Shadow every root-control variable while sourcing the host-generated env.
  # Ordinary runtime variables intentionally persist as globals.
  local INDUSTRIAL_DIAGNOSIS_HOST_IDENTITY_MODE="$INDUSTRIAL_DIAGNOSIS_HOST_IDENTITY_MODE"
  local INDUSTRIAL_DIAGNOSIS_HOST_UID="${INDUSTRIAL_DIAGNOSIS_HOST_UID:-}"
  local INDUSTRIAL_DIAGNOSIS_HOST_GID="${INDUSTRIAL_DIAGNOSIS_HOST_GID:-}"
  local INDUSTRIAL_DIAGNOSIS_RECONCILE_SESSION_PERMISSIONS=
  local INDUSTRIAL_DIAGNOSIS_MOUNT_PREPARE_MODE=
  local INDUSTRIAL_DIAGNOSIS_RUNTIME_USER=
  local INDUSTRIAL_DIAGNOSIS_SESSION_ROOT=
  local INDUSTRIAL_DIAGNOSIS_SESSION_PERMISSION_HELPER=
  local INDUSTRIAL_DIAGNOSIS_SESSION_PERMISSION_INTERVAL=
  local INDUSTRIAL_DIAGNOSIS_SESSION_PERMISSION_PID=
  local INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE="$INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE"
  local INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_UID="$INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_UID"
  local INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_GID="$INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_GID"
  local INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID="$INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID"
  if [ -f /workspace/env-dir/env ]; then
    set -a
    # Fixed read-only bind generated by the host.
    # shellcheck disable=SC1091
    source /workspace/env-dir/env
    set +a
  fi
}

industrial_diagnosis_migrate_direct_managed_paths() {
  [ "$INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE" = direct ] || return 0
  # The fixed-root descriptor walker changes only legacy uid 1000 ownership.
  # It intentionally rescans on every start: an agent-forgeable completion
  # marker could otherwise preserve unsafe modes after an image rollback.
  /usr/local/bin/node /app/session-permissions-watcher.mjs --migrate-direct
}

industrial_diagnosis_verify_rootless_bridge() {
  local mounted_path current_uid legacy_uid
  [ "$INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE" = rootless ] || return 0
  legacy_uid="$INDUSTRIAL_DIAGNOSIS_INTERNAL_RUNTIME_UID"
  for mounted_path in \
    /home/node/.claude /home/node/.feishu-cli \
    /workspace/group /workspace/ipc /workspace/extra; do
    [ -e "$mounted_path" ] || continue
    current_uid=$(stat -c %u "$mounted_path") || return 1
    if [ "$current_uid" != 0 ] && [ "$current_uid" != "$legacy_uid" ]; then
      industrial_diagnosis_permission_fatal \
        "rootless bind root $mounted_path has unexpected uid $current_uid (allowed: 0 or legacy node uid $legacy_uid)"
      return 1
    fi
  done
}

industrial_diagnosis_start_session_permission_watcher() {
  local attempt watcher_mode
  case "$INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE" in
    rootless) watcher_mode= ;;
    host-root | virtualized) watcher_mode=--watch-node-owned-mounts ;;
    *) return 0 ;;
  esac
  industrial_diagnosis_verify_rootless_bridge || return 1
  rm -f -- /run/industrial-diagnosis-session-watcher.ready /run/industrial-diagnosis-session-watcher.failed
  /usr/local/bin/node /app/session-permissions-watcher.mjs $watcher_mode &
  INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID=$!
  for ((attempt = 0; attempt < 500; attempt++)); do
    if [ -e /run/industrial-diagnosis-session-watcher.ready ]; then
      export INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID
      return 0
    fi
    if [ -e /run/industrial-diagnosis-session-watcher.failed ] || \
      ! kill -0 "$INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID" 2>/dev/null; then
      wait "$INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID" 2>/dev/null || true
      INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID=
      industrial_diagnosis_permission_fatal "rootless permission watcher failed before readiness"
      return 1
    fi
    sleep 0.02
  done
  kill "$INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID" 2>/dev/null || true
  wait "$INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID" 2>/dev/null || true
  INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID=
  industrial_diagnosis_permission_fatal "rootless permission watcher readiness timed out"
}

industrial_diagnosis_stop_session_permission_watcher() {
  local watcher_status=0
  if [ -n "$INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID" ]; then
    kill "$INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID" 2>/dev/null || true
    wait "$INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID" 2>/dev/null || watcher_status=$?
    INDUSTRIAL_DIAGNOSIS_INTERNAL_WATCHER_PID=
  fi
  if [ "$watcher_status" -ne 0 ]; then
    industrial_diagnosis_permission_fatal "permission watcher final scan failed"
    return 1
  fi
  case "$INDUSTRIAL_DIAGNOSIS_INTERNAL_IDENTITY_MODE" in
    direct)
      /usr/local/bin/node /app/session-permissions-watcher.mjs --migrate-direct
      ;;
    rootless)
      /usr/local/bin/node /app/session-permissions-watcher.mjs --once
      ;;
  esac
}
