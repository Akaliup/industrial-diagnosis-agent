/**
 * 设备智诊 Schema 与迁移。
 *
 * 表建在 Miniclaw 现有 SQLite 连接上；不修改旧表，不改变主服务迁移版本。
 * 迁移具备：版本记录、前向升级、拒绝降级、事务、文件库升级前 VACUUM INTO 备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

export type DiagnosisDb = InstanceType<typeof BetterSqlite3>;

export const DIAGNOSIS_SCHEMA_VERSION = 1;

export interface DiagnosisMigrationOptions {
  /** 文件数据库升级前备份目录；内存库跳过。 */
  backupDir?: string;
  /** 测试注入：备份函数抛错时必须中止迁移。 */
  backup?: (db: DiagnosisDb, target: string) => void;
}

function tableExists(db: DiagnosisDb, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return Boolean(row);
}

function getMeta(db: DiagnosisDb, key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM diagnosis_meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setMeta(db: DiagnosisDb, key: string, value: string): void {
  db.prepare(
    `INSERT INTO diagnosis_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function sqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function backupBeforeUpgrade(
  db: DiagnosisDb,
  version: number,
  options: DiagnosisMigrationOptions,
): void {
  if (!options.backupDir) return;
  if ((db as unknown as { memory?: boolean }).memory) return;
  const dir = path.resolve(options.backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(
    dir,
    `diagnosis-v${version}-to-v${DIAGNOSIS_SCHEMA_VERSION}-${Date.now()}.db`,
  );
  try {
    if (options.backup) options.backup(db, target);
    else db.exec(`VACUUM INTO ${sqliteLiteral(target)}`);
    if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
      throw new Error('备份文件为空');
    }
  } catch (error) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // 保留原始备份失败原因
    }
    throw new Error(
      `拒绝迁移设备智诊 Schema v${version}→v${DIAGNOSIS_SCHEMA_VERSION}：升级前备份失败`,
      { cause: error },
    );
  }
}

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS diagnosis_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment_registry (
  workspace_id TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  serial TEXT NOT NULL,
  asset_category TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  manual_document_id TEXT,
  manual_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, equipment_id),
  UNIQUE (workspace_id, serial)
);

CREATE TABLE IF NOT EXISTS diagnosis_sources (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  data_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  auth_kind TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_test_at TEXT,
  last_test_ok INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS diagnosis_alarms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_alarm_id TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  cleared_at TEXT,
  message TEXT NOT NULL,
  data_mode TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scenario_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_diag_alarms_ws_time
  ON diagnosis_alarms (workspace_id, raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_alarms_equipment
  ON diagnosis_alarms (workspace_id, equipment_id, raised_at DESC);

CREATE TABLE IF NOT EXISTS diagnosis_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  alarm_id TEXT,
  equipment_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  symptom TEXT,
  data_mode TEXT NOT NULL,
  model_mode TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  stage_rounds_json TEXT NOT NULL DEFAULT '{}',
  total_rounds INTEGER NOT NULL DEFAULT 0,
  logical_calls INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  no_new_evidence_rounds INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT,
  error TEXT,
  handoff_reason TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  conclusion_status TEXT NOT NULL DEFAULT 'hypothesis',
  scenario_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_diag_runs_ws_created
  ON diagnosis_runs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_runs_status
  ON diagnosis_runs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_diag_runs_alarm
  ON diagnosis_runs (workspace_id, alarm_id);

CREATE TABLE IF NOT EXISTS diagnosis_hypotheses (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES diagnosis_runs(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  rationale TEXT NOT NULL,
  supporting_json TEXT NOT NULL DEFAULT '[]',
  contradicting_json TEXT NOT NULL DEFAULT '[]',
  missing_json TEXT NOT NULL DEFAULT '[]',
  next_check TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diag_hyp_run ON diagnosis_hypotheses (run_id);

CREATE TABLE IF NOT EXISTS diagnosis_evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES diagnosis_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  data_mode TEXT NOT NULL,
  equipment_id TEXT,
  observed_at TEXT,
  fetched_at TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  supersedes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, source_id, source_record_id, payload_hash)
);
CREATE INDEX IF NOT EXISTS idx_diag_evidence_run ON diagnosis_evidence (run_id);
CREATE INDEX IF NOT EXISTS idx_diag_evidence_equipment
  ON diagnosis_evidence (workspace_id, equipment_id);

CREATE TABLE IF NOT EXISTS diagnosis_tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES diagnosis_runs(id) ON DELETE CASCADE,
  logical_call_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  tool TEXT NOT NULL,
  role TEXT NOT NULL,
  args_json TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  policy_decision TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_diag_calls_run ON diagnosis_tool_calls (run_id, started_at);

CREATE TABLE IF NOT EXISTS diagnosis_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES diagnosis_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '1',
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_diag_events_run_seq ON diagnosis_events (run_id, seq);

CREATE TABLE IF NOT EXISTS diagnosis_reports (
  run_id TEXT PRIMARY KEY REFERENCES diagnosis_runs(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diagnosis_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES diagnosis_runs(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  comment TEXT NOT NULL,
  observations_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diag_reviews_run ON diagnosis_reviews (run_id);

CREATE TABLE IF NOT EXISTS diagnosis_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES diagnosis_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  evidence_snapshot_hash TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  status TEXT NOT NULL,
  receipt_status TEXT,
  expires_at TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diag_approvals_ws ON diagnosis_approvals (workspace_id, status);

CREATE TABLE IF NOT EXISTS diagnosis_control_receipts (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES diagnosis_approvals(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  workspace_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  title TEXT NOT NULL,
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  manual_version TEXT NOT NULL,
  effective_date TEXT,
  file_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_model
  ON knowledge_documents (workspace_id, model, manual_version);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  workspace_id TEXT NOT NULL,
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  printed_page TEXT,
  section TEXT,
  text TEXT NOT NULL,
  models_json TEXT NOT NULL DEFAULT '[]',
  version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc
  ON knowledge_chunks (workspace_id, document_id, page);

CREATE TABLE IF NOT EXISTS diagnosis_context_manifests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES diagnosis_runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  stage TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diagnosis_eval_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  split TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  metrics_json TEXT,
  results_json TEXT,
  error TEXT
);
`;

function createFts(db: DiagnosisDb): string | null {
  const candidates = ['trigram', 'unicode61'];
  for (const tokenizer of candidates) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
           chunk_id UNINDEXED,
           text,
           section,
           tokenize='${tokenizer}'
         )`,
      );
      return tokenizer;
    } catch {
      // 尝试下一个 tokenizer
    }
  }
  return null;
}

export function migrateDiagnosis(
  db: DiagnosisDb,
  options: DiagnosisMigrationOptions = {},
): { from: number; to: number; tokenizer: string | null } {
  db.exec(`CREATE TABLE IF NOT EXISTS diagnosis_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  const raw = getMeta(db, 'schema_version');
  const current = raw ? Number(raw) : 0;
  if (!Number.isInteger(current) || current < 0) {
    throw new Error(`非法设备智诊 Schema 版本：${raw}`);
  }
  if (current > DIAGNOSIS_SCHEMA_VERSION) {
    throw new Error(
      `设备智诊 Schema v${current} 高于支持的 v${DIAGNOSIS_SCHEMA_VERSION}，拒绝降级`,
    );
  }
  if (current === DIAGNOSIS_SCHEMA_VERSION) {
    return {
      from: current,
      to: DIAGNOSIS_SCHEMA_VERSION,
      tokenizer: getMeta(db, 'fts_tokenizer') ?? null,
    };
  }
  if (current > 0) backupBeforeUpgrade(db, current, options);

  let tokenizer: string | null = null;
  db.transaction(() => {
    db.exec(DDL_V1);
    tokenizer = createFts(db);
    setMeta(db, 'schema_version', String(DIAGNOSIS_SCHEMA_VERSION));
    setMeta(db, 'fts_tokenizer', tokenizer ?? 'none');
    setMeta(db, 'migrated_at', new Date().toISOString());
  })();

  return { from: current, to: DIAGNOSIS_SCHEMA_VERSION, tokenizer };
}

export function diagnosisSchemaVersion(db: DiagnosisDb): number {
  if (!tableExists(db, 'diagnosis_meta')) return 0;
  const raw = getMeta(db, 'schema_version');
  return raw ? Number(raw) : 0;
}
