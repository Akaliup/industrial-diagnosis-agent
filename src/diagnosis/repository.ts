import type {
  Alarm,
  Approval,
  BudgetSnapshot,
  ContextManifest,
  DataMode,
  DiagnosisSource,
  EvalMetrics,
  Evidence,
  EvidenceDraft,
  Hypothesis,
  HypothesisDraft,
  ModelMode,
  Report,
  Review,
  Run,
  RunEvent,
  RunEventType,
  RunStatus,
  Stage,
  ToolError,
  Window,
} from './contracts/domain.js';
import type { DiagnosisDb } from './db.js';
import { canonicalJson, newId, nowIso, sha256, toBool } from './util.js';

export interface EquipmentRecordInput {
  equipment_id: string;
  name: string;
  vendor: string;
  model: string;
  serial: string;
  asset_category: string;
  source_ids: Record<string, string>;
  metrics: Record<
    string,
    { unit: string; normalized_unit?: string; normal_range?: [number, number] }
  >;
  manual_document_id?: string | null;
  manual_version?: string | null;
}

export interface CreateRunInput {
  id: string;
  workspaceId: string;
  userId: string;
  alarmId: string | null;
  equipmentId: string;
  window: Window;
  symptom: string | null;
  dataMode: DataMode;
  modelMode: ModelMode;
  budget: BudgetSnapshot;
  scenarioId: string | null;
}

export interface AlarmInput {
  id: string;
  workspaceId: string;
  sourceId: string;
  sourceAlarmId: string;
  equipmentId: string;
  code: string;
  severity: string;
  state: string;
  raisedAt: string;
  clearedAt: string | null;
  message: string;
  dataMode: DataMode;
  idempotencyKey: string;
  scenarioId: string | null;
}

export interface ToolCallRecordInput {
  id: string;
  runId: string;
  logicalCallId: string;
  attempt: number;
  tool: string;
  role: string;
  args: unknown;
  argsHash: string;
  status: string;
  errorCode: string | null;
  durationMs: number;
  evidenceCount: number;
  policyDecision: string;
  startedAt: string;
  /** inflight 日志在回执落库前为 null。 */
  finishedAt: string | null;
}

export interface ModelCallRecordInput {
  id: string;
  runId: string;
  role: string;
  stage: string;
  round: number;
  attempt: number;
  model: string;
  mode: string;
  status: 'success' | 'error';
  errorCode: string | null;
  failureReason: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolRequests: unknown[];
  rawOutput: string | null;
}

export interface KnowledgeDocumentInput {
  workspaceId: string;
  documentId: string;
  title: string;
  vendor: string;
  model: string;
  manualVersion: string;
  effectiveDate: string | null;
  fileHash: string;
  filePath: string;
  parserVersion: string;
  status: string;
}

export interface KnowledgeChunkInput {
  chunkId: string;
  documentId: string;
  page: number;
  printedPage: string | null;
  section: string | null;
  text: string;
  models: string[];
  version: string;
}

export interface KnowledgeHit {
  document: {
    document_id: string;
    title: string;
    vendor: string;
    model: string;
    manual_version: string;
    effective_date: string | null;
    file_hash: string;
    file_path: string;
    withdrawn: boolean;
  };
  chunk: {
    chunk_id: string;
    page: number;
    printed_page: string | null;
    section: string | null;
    text: string;
  };
  score: number;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRun(row: Record<string, unknown>): Run {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    user_id: String(row.user_id),
    status: row.status as RunStatus,
    stage: row.stage as Stage,
    alarm_id: (row.alarm_id as string | null) ?? null,
    equipment_id: String(row.equipment_id),
    window: {
      start: String(row.window_start),
      end: String(row.window_end),
    },
    symptom: (row.symptom as string | null) ?? null,
    data_mode: row.data_mode as DataMode,
    model_mode: row.model_mode as ModelMode,
    budget: parseJson(String(row.budget_json), {} as BudgetSnapshot),
    stage_rounds: parseJson(String(row.stage_rounds_json), {}),
    total_rounds: Number(row.total_rounds),
    logical_calls: Number(row.logical_calls),
    model_calls: Number(row.model_calls),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    no_new_evidence_rounds: Number(row.no_new_evidence_rounds),
    checkpoint: parseJson(row.checkpoint_json as string | null, null),
    error: (row.error as string | null) ?? null,
    handoff_reason: (row.handoff_reason as string | null) ?? null,
    review_status: row.review_status as Run['review_status'],
    conclusion_status: row.conclusion_status as Run['conclusion_status'],
    created_at: String(row.created_at),
    started_at: (row.started_at as string | null) ?? null,
    finished_at: (row.finished_at as string | null) ?? null,
    lease_owner: (row.lease_owner as string | null) ?? null,
    lease_expires_at: (row.lease_expires_at as string | null) ?? null,
    lease_token: Number(row.lease_token ?? 0),
  };
}

function mapAlarm(row: Record<string, unknown>): Alarm {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    source_id: String(row.source_id),
    source_alarm_id: String(row.source_alarm_id),
    equipment_id: String(row.equipment_id),
    code: String(row.code),
    severity: row.severity as Alarm['severity'],
    state: row.state as Alarm['state'],
    raised_at: String(row.raised_at),
    cleared_at: (row.cleared_at as string | null) ?? null,
    message: String(row.message),
    data_mode: row.data_mode as DataMode,
    idempotency_key: String(row.idempotency_key),
    created_at: String(row.created_at),
  };
}

function mapEvidence(row: Record<string, unknown>): Evidence {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    run_id: String(row.run_id),
    source_id: String(row.source_id),
    source_kind: row.source_kind as Evidence['source_kind'],
    data_mode: row.data_mode as DataMode,
    equipment_id: (row.equipment_id as string | null) ?? null,
    observed_at: (row.observed_at as string | null) ?? null,
    fetched_at: String(row.fetched_at),
    source_record_id: String(row.source_record_id),
    payload_hash: String(row.payload_hash),
    query_hash: String(row.query_hash),
    locator: parseJson(String(row.locator_json), {
      kind: 'db',
      ref: 'unknown',
    }),
    quality_flags: parseJson(String(row.quality_json), []),
    payload: parseJson(String(row.payload_json), {
      kind: 'status_snapshot',
      equipment_id: '',
      state: 'unknown',
      mode: null,
      last_seen: null,
      points: [],
    }),
  } as Evidence;
}

function mapHypothesis(row: Record<string, unknown>): Hypothesis {
  return {
    id: String(row.id),
    code: row.code as Hypothesis['code'],
    title: String(row.title),
    description: String(row.description),
    status: row.status as Hypothesis['status'],
    confidence: row.confidence as Hypothesis['confidence'],
    rationale: String(row.rationale),
    supporting_evidence_ids: parseJson(String(row.supporting_json), []),
    contradicting_evidence_ids: parseJson(String(row.contradicting_json), []),
    missing_evidence: parseJson(String(row.missing_json), []),
    next_check: (row.next_check as string | null) ?? null,
  };
}

export class DiagnosisRepository {
  constructor(readonly db: DiagnosisDb) {}

  // -------------------------------------------------------------------------
  // Equipment
  // -------------------------------------------------------------------------

  upsertEquipment(workspaceId: string, e: EquipmentRecordInput): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO equipment_registry (
           workspace_id, equipment_id, name, vendor, model, serial, asset_category,
           source_ids_json, metrics_json, manual_document_id, manual_version,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, equipment_id) DO UPDATE SET
           name=excluded.name, vendor=excluded.vendor, model=excluded.model,
           serial=excluded.serial, asset_category=excluded.asset_category,
           source_ids_json=excluded.source_ids_json,
           metrics_json=excluded.metrics_json,
           manual_document_id=excluded.manual_document_id,
           manual_version=excluded.manual_version,
           updated_at=excluded.updated_at`,
      )
      .run(
        workspaceId,
        e.equipment_id,
        e.name,
        e.vendor,
        e.model,
        e.serial,
        e.asset_category,
        JSON.stringify(e.source_ids),
        JSON.stringify(e.metrics),
        e.manual_document_id ?? null,
        e.manual_version ?? null,
        now,
        now,
      );
  }

  getEquipment(
    workspaceId: string,
    equipmentId: string,
  ): EquipmentRecordInput | null {
    const row = this.db
      .prepare(
        'SELECT * FROM equipment_registry WHERE workspace_id = ? AND equipment_id = ?',
      )
      .get(workspaceId, equipmentId) as Record<string, unknown> | undefined;
    return row ? this.mapEquipment(row) : null;
  }

  listEquipment(workspaceId: string): EquipmentRecordInput[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM equipment_registry WHERE workspace_id = ? ORDER BY equipment_id',
      )
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map((r) => this.mapEquipment(r));
  }

  resolveEquipment(workspaceId: string, query: string): EquipmentRecordInput[] {
    const q = `%${query.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM equipment_registry
         WHERE workspace_id = ? AND (equipment_id = ? OR serial = ? OR name LIKE ? OR equipment_id LIKE ?)
         ORDER BY equipment_id`,
      )
      .all(workspaceId, query, query, q, q) as Record<string, unknown>[];
    return rows.map((r) => this.mapEquipment(r));
  }

  private mapEquipment(row: Record<string, unknown>): EquipmentRecordInput {
    return {
      equipment_id: String(row.equipment_id),
      name: String(row.name),
      vendor: String(row.vendor),
      model: String(row.model),
      serial: String(row.serial),
      asset_category: String(row.asset_category),
      source_ids: parseJson(String(row.source_ids_json), {}),
      metrics: parseJson(String(row.metrics_json), {}),
      manual_document_id: (row.manual_document_id as string | null) ?? null,
      manual_version: (row.manual_version as string | null) ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  upsertSource(workspaceId: string, source: DiagnosisSource): void {
    this.db
      .prepare(
        `INSERT INTO diagnosis_sources (
           workspace_id, id, kind, name, data_mode, status, auth_kind,
           config_json, last_test_at, last_test_ok, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)
         ON CONFLICT(workspace_id, id) DO UPDATE SET
           kind=excluded.kind, name=excluded.name, data_mode=excluded.data_mode,
           status=excluded.status, auth_kind=excluded.auth_kind,
           last_test_at=excluded.last_test_at, last_test_ok=excluded.last_test_ok,
           notes=excluded.notes`,
      )
      .run(
        workspaceId,
        source.id,
        source.kind,
        source.name,
        source.data_mode,
        source.status,
        source.auth_kind,
        source.last_test_at,
        source.last_test_ok === null ? null : source.last_test_ok ? 1 : 0,
        source.notes,
      );
  }

  listSources(workspaceId: string): DiagnosisSource[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM diagnosis_sources WHERE workspace_id = ? ORDER BY id',
      )
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      kind: row.kind as DiagnosisSource['kind'],
      name: String(row.name),
      data_mode: row.data_mode as DataMode,
      status: row.status as DiagnosisSource['status'],
      auth_kind: String(row.auth_kind),
      last_test_at: (row.last_test_at as string | null) ?? null,
      last_test_ok: row.last_test_ok === null ? null : toBool(row.last_test_ok),
      notes: String(row.notes),
    }));
  }

  updateSourceStatus(
    workspaceId: string,
    sourceId: string,
    status: DiagnosisSource['status'],
  ): void {
    this.db
      .prepare(
        'UPDATE diagnosis_sources SET status = ? WHERE workspace_id = ? AND id = ?',
      )
      .run(status, workspaceId, sourceId);
  }

  updateSourceTest(
    workspaceId: string,
    sourceId: string,
    ok: boolean,
    notes: string,
  ): void {
    this.db
      .prepare(
        `UPDATE diagnosis_sources
         SET last_test_at = ?, last_test_ok = ?, notes = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(nowIso(), ok ? 1 : 0, notes, workspaceId, sourceId);
  }

  // -------------------------------------------------------------------------
  // Alarms
  // -------------------------------------------------------------------------

  upsertAlarm(input: AlarmInput): { alarm: Alarm; created: boolean } {
    const existing = this.db
      .prepare(
        'SELECT * FROM diagnosis_alarms WHERE workspace_id = ? AND idempotency_key = ?',
      )
      .get(input.workspaceId, input.idempotencyKey) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      // 报警恢复是事件更新，不是新报警；保留原始 raised_at。
      if (input.clearedAt || input.state === 'cleared') {
        this.db
          .prepare(
            `UPDATE diagnosis_alarms
             SET state = ?, cleared_at = COALESCE(?, cleared_at)
             WHERE id = ?`,
          )
          .run(input.state, input.clearedAt, existing.id);
      }
      // 演示场景可能引用基础报警；同一条报警只补场景绑定，不复制第二行。
      if (input.scenarioId) {
        this.db
          .prepare('UPDATE diagnosis_alarms SET scenario_id = ? WHERE id = ?')
          .run(input.scenarioId, existing.id);
      }
      const row = this.db
        .prepare('SELECT * FROM diagnosis_alarms WHERE id = ?')
        .get(existing.id) as Record<string, unknown>;
      return { alarm: mapAlarm(row), created: false };
    }
    this.db
      .prepare(
        `INSERT INTO diagnosis_alarms (
           id, workspace_id, source_id, source_alarm_id, equipment_id, code,
           severity, state, raised_at, cleared_at, message, data_mode,
           idempotency_key, scenario_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.sourceId,
        input.sourceAlarmId,
        input.equipmentId,
        input.code,
        input.severity,
        input.state,
        input.raisedAt,
        input.clearedAt,
        input.message,
        input.dataMode,
        input.idempotencyKey,
        input.scenarioId,
        nowIso(),
      );
    const row = this.db
      .prepare('SELECT * FROM diagnosis_alarms WHERE id = ?')
      .get(input.id) as Record<string, unknown>;
    return { alarm: mapAlarm(row), created: true };
  }

  listAlarms(
    workspaceId: string,
    filters: {
      state?: string;
      severity?: string;
      equipmentId?: string;
      from?: string;
      to?: string;
      limit?: number;
    } = {},
  ): Array<Alarm & { scenario_id: string | null }> {
    const where = ['workspace_id = ?'];
    const params: unknown[] = [workspaceId];
    if (filters.state) {
      where.push('state = ?');
      params.push(filters.state);
    }
    if (filters.severity) {
      where.push('severity = ?');
      params.push(filters.severity);
    }
    if (filters.equipmentId) {
      where.push('equipment_id = ?');
      params.push(filters.equipmentId);
    }
    if (filters.from) {
      where.push('raised_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('raised_at <= ?');
      params.push(filters.to);
    }
    params.push(Math.min(filters.limit ?? 100, 200));
    const rows = this.db
      .prepare(
        `SELECT * FROM diagnosis_alarms WHERE ${where.join(' AND ')}
         ORDER BY raised_at DESC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...mapAlarm(row),
      scenario_id: (row.scenario_id as string | null) ?? null,
    }));
  }

  getAlarm(
    workspaceId: string,
    alarmId: string,
  ): (Alarm & { scenario_id: string | null }) | null {
    const row = this.db
      .prepare(
        'SELECT * FROM diagnosis_alarms WHERE workspace_id = ? AND id = ?',
      )
      .get(workspaceId, alarmId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...mapAlarm(row),
      scenario_id: (row.scenario_id as string | null) ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  createRun(input: CreateRunInput): Run {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO diagnosis_runs (
           id, workspace_id, user_id, status, stage, alarm_id, equipment_id,
           window_start, window_end, symptom, data_mode, model_mode, budget_json,
           stage_rounds_json, total_rounds, logical_calls, model_calls,
           input_tokens, output_tokens, no_new_evidence_rounds, checkpoint_json,
           error, handoff_reason, review_status, conclusion_status, scenario_id,
           created_at, started_at, finished_at, lease_owner, lease_expires_at
         ) VALUES (?, ?, ?, 'queued', 'confirm_status', ?, ?, ?, ?, ?, ?, ?, ?,
                   '{}', 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, 'pending', 'hypothesis',
                   ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.userId,
        input.alarmId,
        input.equipmentId,
        input.window.start,
        input.window.end,
        input.symptom,
        input.dataMode,
        input.modelMode,
        JSON.stringify(input.budget),
        input.scenarioId,
        now,
      );
    return this.getRun(input.id)!;
  }

  getRun(id: string): Run | null {
    const row = this.db
      .prepare('SELECT * FROM diagnosis_runs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  getRunScenario(id: string): string | null {
    const row = this.db
      .prepare('SELECT scenario_id FROM diagnosis_runs WHERE id = ?')
      .get(id) as { scenario_id: string | null } | undefined;
    return row?.scenario_id ?? null;
  }

  listRuns(workspaceId: string, limit = 50): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM diagnosis_runs WHERE workspace_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, Math.min(limit, 200)) as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  findRunByAlarm(workspaceId: string, alarmId: string): Run | null {
    const row = this.db
      .prepare(
        `SELECT * FROM diagnosis_runs
         WHERE workspace_id = ? AND alarm_id = ?
           AND status IN ('queued','running','awaiting_human')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(workspaceId, alarmId) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  updateRun(
    id: string,
    patch: Partial<{
      status: RunStatus;
      stage: Stage;
      stage_rounds: Record<string, number>;
      total_rounds: number;
      logical_calls: number;
      model_calls: number;
      input_tokens: number;
      output_tokens: number;
      no_new_evidence_rounds: number;
      checkpoint: Record<string, unknown> | null;
      error: string | null;
      handoff_reason: string | null;
      review_status: Run['review_status'];
      conclusion_status: Run['conclusion_status'];
      started_at: string | null;
      finished_at: string | null;
      lease_owner: string | null;
      lease_expires_at: string | null;
    }>,
  ): void {
    const columns: Record<string, { column: string; json?: boolean }> = {
      status: { column: 'status' },
      stage: { column: 'stage' },
      stage_rounds: { column: 'stage_rounds_json', json: true },
      total_rounds: { column: 'total_rounds' },
      logical_calls: { column: 'logical_calls' },
      model_calls: { column: 'model_calls' },
      input_tokens: { column: 'input_tokens' },
      output_tokens: { column: 'output_tokens' },
      no_new_evidence_rounds: { column: 'no_new_evidence_rounds' },
      checkpoint: { column: 'checkpoint_json', json: true },
      error: { column: 'error' },
      handoff_reason: { column: 'handoff_reason' },
      review_status: { column: 'review_status' },
      conclusion_status: { column: 'conclusion_status' },
      started_at: { column: 'started_at' },
      finished_at: { column: 'finished_at' },
      lease_owner: { column: 'lease_owner' },
      lease_expires_at: { column: 'lease_expires_at' },
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, spec] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${spec.column} = ?`);
      const value = (patch as Record<string, unknown>)[key];
      values.push(
        spec.json ? (value === null ? null : JSON.stringify(value)) : value,
      );
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db
      .prepare(`UPDATE diagnosis_runs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  /**
   * 仅当 Run 仍属于当前租约令牌时更新；用于 Worker 在长时间模型调用后
   * 发现自己已被新 Worker 接管时放弃写入。
   */
  updateRunFenced(
    id: string,
    leaseToken: number,
    patch: Partial<Parameters<DiagnosisRepository['updateRun']>[1]>,
  ): boolean {
    const columns: Record<string, { column: string; json?: boolean }> = {
      status: { column: 'status' },
      stage: { column: 'stage' },
      stage_rounds: { column: 'stage_rounds_json', json: true },
      total_rounds: { column: 'total_rounds' },
      logical_calls: { column: 'logical_calls' },
      model_calls: { column: 'model_calls' },
      input_tokens: { column: 'input_tokens' },
      output_tokens: { column: 'output_tokens' },
      no_new_evidence_rounds: { column: 'no_new_evidence_rounds' },
      checkpoint: { column: 'checkpoint_json', json: true },
      error: { column: 'error' },
      handoff_reason: { column: 'handoff_reason' },
      review_status: { column: 'review_status' },
      conclusion_status: { column: 'conclusion_status' },
      started_at: { column: 'started_at' },
      finished_at: { column: 'finished_at' },
      lease_owner: { column: 'lease_owner' },
      lease_expires_at: { column: 'lease_expires_at' },
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, spec] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      sets.push(`${spec.column} = ?`);
      const value = (patch as Record<string, unknown>)[key];
      values.push(
        spec.json ? (value === null ? null : JSON.stringify(value)) : value,
      );
    }
    if (sets.length === 0) return true;
    const result = this.db
      .prepare(
        `UPDATE diagnosis_runs SET ${sets.join(', ')}
         WHERE id = ? AND lease_token = ?`,
      )
      .run(...values, id, leaseToken);
    return result.changes > 0;
  }

  leaseTokenMatches(runId: string, leaseToken: number): boolean {
    const row = this.db
      .prepare('SELECT lease_token FROM diagnosis_runs WHERE id=?')
      .get(runId) as { lease_token: number } | undefined;
    return row ? Number(row.lease_token) === leaseToken : false;
  }

  /**
   * CAS 领取 Run；成功时递增租约令牌并返回新令牌。
   * 令牌即使租约被释放也不会回退，旧 Worker 的迟到写入因此无法命中。
   */
  claimRun(id: string, owner: string, leaseMs: number): number | null {
    const now = nowIso();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE diagnosis_runs
         SET status='running', lease_owner=?, lease_expires_at=?,
             lease_token=lease_token+1, started_at=COALESCE(started_at, ?)
         WHERE id=? AND (
           status='queued' OR
           (status='running' AND (lease_expires_at IS NULL OR lease_expires_at < ?))
         )`,
      )
      .run(owner, leaseUntil, now, id, now);
    if (result.changes === 0) return null;
    const row = this.db
      .prepare('SELECT lease_token FROM diagnosis_runs WHERE id=?')
      .get(id) as { lease_token: number } | undefined;
    return row ? Number(row.lease_token) : null;
  }

  renewLease(
    id: string,
    owner: string,
    leaseToken: number,
    leaseMs: number,
  ): boolean {
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE diagnosis_runs SET lease_expires_at=?
         WHERE id=? AND lease_owner=? AND lease_token=? AND status='running'`,
      )
      .run(leaseUntil, id, owner, leaseToken);
    return result.changes > 0;
  }

  releaseLease(id: string, owner?: string, leaseToken?: number): void {
    if (owner !== undefined && leaseToken !== undefined) {
      this.db
        .prepare(
          `UPDATE diagnosis_runs SET lease_owner=NULL, lease_expires_at=NULL
           WHERE id=? AND lease_owner=? AND lease_token=?`,
        )
        .run(id, owner, leaseToken);
      return;
    }
    this.db
      .prepare(
        'UPDATE diagnosis_runs SET lease_owner=NULL, lease_expires_at=NULL WHERE id=?',
      )
      .run(id);
  }

  findQueuedRuns(limit = 5): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM diagnosis_runs WHERE status='queued'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  findExpiredRunningRuns(now: string): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM diagnosis_runs
         WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .all(now) as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  appendEvent(
    runId: string,
    type: RunEventType,
    payload: Record<string, unknown> = {},
  ): RunEvent {
    const event = this.db.transaction(() => {
      const next = this.db
        .prepare(
          'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM diagnosis_events WHERE run_id = ?',
        )
        .get(runId) as { seq: number };
      const event: RunEvent = {
        event_id: newId('evt'),
        run_id: runId,
        seq: next.seq,
        timestamp: nowIso(),
        type,
        payload,
        schema_version: '1',
      };
      this.db
        .prepare(
          `INSERT INTO diagnosis_events
           (event_id, run_id, seq, timestamp, type, payload_json, schema_version)
           VALUES (?, ?, ?, ?, ?, ?, '1')`,
        )
        .run(
          event.event_id,
          event.run_id,
          event.seq,
          event.timestamp,
          event.type,
          JSON.stringify(event.payload),
        );
      return event;
    })();
    return event;
  }

  listEvents(runId: string, afterSeq = 0, limit = 500): RunEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM diagnosis_events WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(runId, afterSeq, Math.min(limit, 1000)) as Record<string, unknown>[];
    return rows.map((row) => ({
      event_id: String(row.event_id),
      run_id: String(row.run_id),
      seq: Number(row.seq),
      timestamp: String(row.timestamp),
      type: row.type as RunEventType,
      payload: parseJson(String(row.payload_json), {}),
      schema_version: '1',
    }));
  }

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  ingestEvidence(
    draft: EvidenceDraft,
    leaseToken?: number,
  ): { evidence: Evidence; isNew: boolean } | null {
    if (
      leaseToken !== undefined &&
      !this.leaseTokenMatches(draft.run_id, leaseToken)
    ) {
      return null;
    }
    const payloadHash = sha256(canonicalJson(draft.payload));
    const id = `ev_${sha256(
      `${draft.workspace_id}|${draft.run_id}|${draft.source_id}|${draft.source_record_id}|${payloadHash}`,
    ).slice(0, 20)}`;
    const existing = this.db
      .prepare(
        `SELECT * FROM diagnosis_evidence
         WHERE run_id = ? AND source_id = ? AND source_record_id = ? AND payload_hash = ?`,
      )
      .get(
        draft.run_id,
        draft.source_id,
        draft.source_record_id,
        payloadHash,
      ) as Record<string, unknown> | undefined;
    if (existing) return { evidence: mapEvidence(existing), isNew: false };
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO diagnosis_evidence (
           id, workspace_id, run_id, source_id, source_kind, data_mode,
           equipment_id, observed_at, fetched_at, source_record_id, payload_hash,
           query_hash, locator_json, quality_json, payload_json, supersedes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        draft.workspace_id,
        draft.run_id,
        draft.source_id,
        draft.source_kind,
        draft.data_mode,
        draft.equipment_id,
        draft.observed_at,
        draft.fetched_at || now,
        draft.source_record_id,
        payloadHash,
        draft.query_hash,
        JSON.stringify(draft.locator),
        JSON.stringify(draft.quality_flags),
        JSON.stringify(draft.payload),
        now,
      );
    const row = this.db
      .prepare('SELECT * FROM diagnosis_evidence WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return { evidence: mapEvidence(row), isNew: true };
  }

  getEvidence(runId: string, evidenceId: string): Evidence | null {
    const row = this.db
      .prepare('SELECT * FROM diagnosis_evidence WHERE run_id = ? AND id = ?')
      .get(runId, evidenceId) as Record<string, unknown> | undefined;
    return row ? mapEvidence(row) : null;
  }

  listEvidence(runId: string, ids?: string[]): Evidence[] {
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT * FROM diagnosis_evidence WHERE run_id = ? AND id IN (${placeholders})`,
        )
        .all(runId, ...ids) as Record<string, unknown>[];
      return rows.map(mapEvidence);
    }
    const rows = this.db
      .prepare(
        'SELECT * FROM diagnosis_evidence WHERE run_id = ? ORDER BY created_at ASC',
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map(mapEvidence);
  }

  countEvidence(runId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM diagnosis_evidence WHERE run_id = ?')
      .get(runId) as { n: number };
    return Number(row.n);
  }

  // -------------------------------------------------------------------------
  // Hypotheses
  // -------------------------------------------------------------------------

  replaceHypotheses(
    runId: string,
    drafts: HypothesisDraft[],
    options: {
      leaseToken?: number;
      statusFor?: (hypothesis: Hypothesis) => Hypothesis['status'];
    } = {},
  ): Hypothesis[] | null {
    let stored: Hypothesis[] | null = null;
    const now = nowIso();
    this.db.transaction(() => {
      if (
        options.leaseToken !== undefined &&
        !this.leaseTokenMatches(runId, options.leaseToken)
      ) {
        return;
      }
      this.db
        .prepare('DELETE FROM diagnosis_hypotheses WHERE run_id = ?')
        .run(runId);
      const insert = this.db.prepare(
        `INSERT INTO diagnosis_hypotheses (
           id, run_id, code, title, description, status, confidence, rationale,
           supporting_json, contradicting_json, missing_json, next_check,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const draft of drafts.slice(0, 5)) {
        insert.run(
          newId('hyp'),
          runId,
          draft.code,
          draft.title,
          draft.description,
          draft.confidence,
          draft.rationale,
          JSON.stringify(draft.supporting_evidence_ids),
          JSON.stringify(draft.contradicting_evidence_ids),
          JSON.stringify(draft.missing_evidence),
          draft.next_check,
          now,
          now,
        );
      }
      stored = this.listHypotheses(runId);
      if (options.statusFor) {
        const update = this.db.prepare(
          'UPDATE diagnosis_hypotheses SET status=?, updated_at=? WHERE id=?',
        );
        for (const hypothesis of stored) {
          update.run(options.statusFor(hypothesis), now, hypothesis.id);
        }
        stored = this.listHypotheses(runId);
      }
    })();
    return stored;
  }

  listHypotheses(runId: string): Hypothesis[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM diagnosis_hypotheses WHERE run_id = ? ORDER BY created_at ASC',
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map(mapHypothesis);
  }

  updateHypothesisStatus(id: string, status: Hypothesis['status']): void {
    this.db
      .prepare(
        'UPDATE diagnosis_hypotheses SET status=?, updated_at=? WHERE id=?',
      )
      .run(status, nowIso(), id);
  }

  // -------------------------------------------------------------------------
  // Tool calls
  // -------------------------------------------------------------------------

  recordToolCall(record: ToolCallRecordInput): void {
    this.db
      .prepare(
        `INSERT INTO diagnosis_tool_calls (
           id, run_id, logical_call_id, attempt, tool, role, args_json,
           args_hash, status, error_code, duration_ms, evidence_count,
           policy_decision, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.logicalCallId,
        record.attempt,
        record.tool,
        record.role,
        JSON.stringify(record.args),
        record.argsHash,
        record.status,
        record.errorCode,
        record.durationMs,
        record.evidenceCount,
        record.policyDecision,
        record.startedAt,
        record.finishedAt,
      );
  }

  listToolCalls(runId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        'SELECT * FROM diagnosis_tool_calls WHERE run_id = ? ORDER BY started_at ASC',
      )
      .all(runId) as Array<Record<string, unknown>>;
  }

  recordModelCall(record: ModelCallRecordInput): void {
    this.db
      .prepare(
        `INSERT INTO diagnosis_model_calls (
           id, run_id, role, stage, round, attempt, model, mode, status,
           error_code, failure_reason, input_tokens, output_tokens, latency_ms,
           tool_requests_json, raw_output, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.role,
        record.stage,
        record.round,
        record.attempt,
        record.model,
        record.mode,
        record.status,
        record.errorCode,
        record.failureReason,
        Math.max(0, Math.trunc(record.inputTokens)),
        Math.max(0, Math.trunc(record.outputTokens)),
        Math.max(0, Math.trunc(record.latencyMs)),
        JSON.stringify(record.toolRequests),
        record.rawOutput ? record.rawOutput.slice(0, 8_000) : null,
        nowIso(),
      );
  }

  listModelCalls(runId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        'SELECT * FROM diagnosis_model_calls WHERE run_id = ? ORDER BY created_at ASC, round ASC, attempt ASC',
      )
      .all(runId) as Array<Record<string, unknown>>;
  }

  countModelCallFailures(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM diagnosis_model_calls WHERE run_id = ? AND status = 'error'",
      )
      .get(runId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  /**
   * 完成一条预先落库的 inflight 调用记录。
   * 只更新仍处于 inflight 的行；恢复流程已标记 unknown 的记录不会被迟到回执覆盖。
   * 传入 leaseToken 时同时校验 Run 的租约令牌，旧 Worker 无法写入新执行。
   */
  finishToolCall(
    id: string,
    patch: {
      status: string;
      errorCode: string | null;
      durationMs: number;
      evidenceCount: number;
    },
    leaseToken?: number,
  ): boolean {
    const finishedAt = nowIso();
    const result =
      leaseToken === undefined
        ? this.db
            .prepare(
              `UPDATE diagnosis_tool_calls
               SET status=?, error_code=?, duration_ms=?, evidence_count=?, finished_at=?
               WHERE id=? AND status='inflight'`,
            )
            .run(
              patch.status,
              patch.errorCode,
              patch.durationMs,
              patch.evidenceCount,
              finishedAt,
              id,
            )
        : this.db
            .prepare(
              `UPDATE diagnosis_tool_calls
               SET status=?, error_code=?, duration_ms=?, evidence_count=?, finished_at=?
               WHERE id=? AND status='inflight'
                 AND EXISTS (
                   SELECT 1 FROM diagnosis_runs
                   WHERE id = diagnosis_tool_calls.run_id AND lease_token = ?
                 )`,
            )
            .run(
              patch.status,
              patch.errorCode,
              patch.durationMs,
              patch.evidenceCount,
              finishedAt,
              id,
              leaseToken,
            );
    return result.changes > 0;
  }

  /**
   * 恢复执行前，把上次崩溃遗留的 inflight 调用标记为 unknown。
   * 请求可能已经发出，但回执没有落库，因此既不能当作成功，也不能当作未执行；
   * 后续重新检索会以确定性的证据 ID 去重，不会重复推进结论。
   */
  markInflightToolCallsFenced(
    runId: string,
    leaseToken: number,
    errorCode: string,
  ): Array<{ id: string; logical_call_id: string }> {
    let marked: Array<{ id: string; logical_call_id: string }> = [];
    this.db.transaction(() => {
      if (!this.leaseTokenMatches(runId, leaseToken)) return;
      marked = this.db
        .prepare(
          `SELECT id, logical_call_id FROM diagnosis_tool_calls
           WHERE run_id = ? AND status = 'inflight'`,
        )
        .all(runId) as Array<{ id: string; logical_call_id: string }>;
      if (marked.length === 0) return;
      this.db
        .prepare(
          `UPDATE diagnosis_tool_calls
           SET status='unknown', error_code=?, finished_at=?
           WHERE run_id = ? AND status='inflight'`,
        )
        .run(errorCode, nowIso(), runId);
    })();
    return marked;
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  saveReport(runId: string, report: Report, validation: unknown): void {
    const now = nowIso();
    const hash = sha256(canonicalJson(report));
    this.db
      .prepare(
        `INSERT INTO diagnosis_reports (run_id, report_json, report_hash, validation_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           report_json=excluded.report_json, report_hash=excluded.report_hash,
           validation_json=excluded.validation_json, updated_at=excluded.updated_at`,
      )
      .run(
        runId,
        JSON.stringify(report),
        hash,
        JSON.stringify(validation),
        now,
        now,
      );
  }

  /**
   * 仅在租约令牌仍有效、且 Run 仍在运行时写入报告。
   * 取消/完成是终态：取消路由不会递增租约令牌，因此不能只校验令牌，
   * 否则预算回退或迟到的 Worker 可以把 cancelled 覆盖成 awaiting_human。
   */
  saveReportFenced(
    runId: string,
    leaseToken: number,
    report: Report,
    validation: unknown,
  ): boolean {
    let saved = false;
    this.db.transaction(() => {
      if (!this.leaseTokenMatches(runId, leaseToken)) return;
      const row = this.db
        .prepare('SELECT status FROM diagnosis_runs WHERE id=?')
        .get(runId) as { status: string } | undefined;
      if (!row || row.status !== 'running') return;
      this.saveReport(runId, report, validation);
      saved = true;
    })();
    return saved;
  }

  getReport(runId: string): { report: Report; validation: unknown } | null {
    const row = this.db
      .prepare('SELECT * FROM diagnosis_reports WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      report: parseJson(String(row.report_json), null as unknown as Report),
      validation: parseJson(String(row.validation_json), {}),
    };
  }

  // -------------------------------------------------------------------------
  // Reviews / approvals
  // -------------------------------------------------------------------------

  submitReview(input: {
    id: string;
    runId: string;
    reviewerId: string;
    decision: 'accepted' | 'rejected';
    comment: string;
    observations: string[];
  }): Review {
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO diagnosis_reviews
           (id, run_id, reviewer_id, decision, comment, observations_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.runId,
          input.reviewerId,
          input.decision,
          input.comment,
          JSON.stringify(input.observations),
          now,
        );
      const conclusion =
        input.decision === 'accepted' ? 'engineer_confirmed' : 'hypothesis';
      this.db
        .prepare(
          `UPDATE diagnosis_runs SET review_status=?, conclusion_status=?
           WHERE id=?`,
        )
        .run(input.decision, conclusion, input.runId);
    })();
    return {
      id: input.id,
      run_id: input.runId,
      reviewer_id: input.reviewerId,
      decision: input.decision,
      comment: input.comment,
      observations: input.observations,
      created_at: now,
    };
  }

  listReviews(runId: string): Review[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM diagnosis_reviews WHERE run_id = ? ORDER BY created_at ASC',
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      run_id: String(row.run_id),
      reviewer_id: String(row.reviewer_id),
      decision: row.decision as Review['decision'],
      comment: String(row.comment),
      observations: parseJson(String(row.observations_json), []),
      created_at: String(row.created_at),
    }));
  }

  createApproval(approval: Approval): void {
    this.db
      .prepare(
        `INSERT INTO diagnosis_approvals (
           id, run_id, workspace_id, action_id, equipment_id, risk_level,
           params_hash, evidence_snapshot_hash, requested_by, approved_by,
           status, receipt_status, expires_at, policy_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.run_id,
        approval.workspace_id,
        approval.action_id,
        approval.equipment_id,
        approval.risk_level,
        approval.params_hash,
        approval.evidence_snapshot_hash,
        approval.requested_by,
        approval.approved_by,
        approval.status,
        approval.receipt_status,
        approval.expires_at,
        approval.policy_version,
        approval.created_at,
        approval.created_at,
      );
  }

  getApproval(workspaceId: string, id: string): Approval | null {
    const row = this.db
      .prepare(
        'SELECT * FROM diagnosis_approvals WHERE workspace_id = ? AND id = ?',
      )
      .get(workspaceId, id) as Record<string, unknown> | undefined;
    return row ? this.mapApproval(row) : null;
  }

  listApprovals(workspaceId: string, status?: string): Approval[] {
    const rows = status
      ? (this.db
          .prepare(
            'SELECT * FROM diagnosis_approvals WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC',
          )
          .all(workspaceId, status) as Record<string, unknown>[])
      : (this.db
          .prepare(
            'SELECT * FROM diagnosis_approvals WHERE workspace_id = ? ORDER BY created_at DESC',
          )
          .all(workspaceId) as Record<string, unknown>[]);
    return rows.map((row) => this.mapApproval(row));
  }

  decideApproval(
    workspaceId: string,
    id: string,
    approvedBy: string,
    decision: 'approved' | 'rejected',
  ): Approval | null {
    const current = this.getApproval(workspaceId, id);
    if (!current) return null;
    if (current.status !== 'pending') return current;
    this.db
      .prepare(
        `UPDATE diagnosis_approvals SET status=?, approved_by=?, updated_at=?
         WHERE workspace_id=? AND id=? AND status='pending'`,
      )
      .run(decision, approvedBy, nowIso(), workspaceId, id);
    return this.getApproval(workspaceId, id);
  }

  invalidateApprovals(runId: string): void {
    this.db
      .prepare(
        `UPDATE diagnosis_approvals SET status='invalidated', updated_at=?
         WHERE run_id=? AND status='pending'`,
      )
      .run(nowIso(), runId);
  }

  setApprovalReceipt(id: string, status: Approval['receipt_status']): void {
    this.db
      .prepare(
        'UPDATE diagnosis_approvals SET receipt_status=?, updated_at=? WHERE id=?',
      )
      .run(status, nowIso(), id);
  }

  private mapApproval(row: Record<string, unknown>): Approval {
    return {
      id: String(row.id),
      run_id: String(row.run_id),
      workspace_id: String(row.workspace_id),
      action_id: String(row.action_id),
      equipment_id: String(row.equipment_id),
      risk_level: row.risk_level as Approval['risk_level'],
      params_hash: String(row.params_hash),
      evidence_snapshot_hash: String(row.evidence_snapshot_hash),
      requested_by: String(row.requested_by),
      approved_by: (row.approved_by as string | null) ?? null,
      status: row.status as Approval['status'],
      receipt_status:
        (row.receipt_status as Approval['receipt_status']) ?? null,
      expires_at: String(row.expires_at),
      policy_version: String(row.policy_version),
      created_at: String(row.created_at),
    };
  }

  createReceipt(input: {
    id: string;
    approvalId: string;
    status: string;
    payload: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO diagnosis_control_receipts (id, approval_id, status, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.approvalId,
        input.status,
        JSON.stringify(input.payload),
        nowIso(),
      );
  }

  getReceipt(approvalId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        'SELECT * FROM diagnosis_control_receipts WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(approvalId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  // -------------------------------------------------------------------------
  // Knowledge
  // -------------------------------------------------------------------------

  upsertDocument(input: KnowledgeDocumentInput): void {
    const existing = this.db
      .prepare(
        'SELECT file_hash, withdrawn FROM knowledge_documents WHERE workspace_id=? AND document_id=?',
      )
      .get(input.workspaceId, input.documentId) as
      | { file_hash: string; withdrawn: number }
      | undefined;
    if (existing && existing.file_hash !== input.fileHash) {
      throw new Error(
        `文档 ${input.documentId} 已存在不同内容（hash 不一致）；新版本必须使用新的 document_id`,
      );
    }
    if (existing) {
      this.db
        .prepare(
          `UPDATE knowledge_documents SET title=?, vendor=?, model=?, manual_version=?,
             effective_date=?, file_path=?, parser_version=?, status=?
           WHERE workspace_id=? AND document_id=?`,
        )
        .run(
          input.title,
          input.vendor,
          input.model,
          input.manualVersion,
          input.effectiveDate,
          input.filePath,
          input.parserVersion,
          input.status,
          input.workspaceId,
          input.documentId,
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO knowledge_documents (
           workspace_id, document_id, title, vendor, model, manual_version,
           effective_date, file_hash, file_path, parser_version, status,
           withdrawn, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        input.workspaceId,
        input.documentId,
        input.title,
        input.vendor,
        input.model,
        input.manualVersion,
        input.effectiveDate,
        input.fileHash,
        input.filePath,
        input.parserVersion,
        input.status,
        nowIso(),
      );
  }

  replaceChunks(
    workspaceId: string,
    documentId: string,
    chunks: KnowledgeChunkInput[],
    ftsAvailable: boolean,
  ): void {
    this.db.transaction(() => {
      const old = this.db
        .prepare(
          'SELECT chunk_id FROM knowledge_chunks WHERE workspace_id=? AND document_id=?',
        )
        .all(workspaceId, documentId) as Array<{ chunk_id: string }>;
      if (ftsAvailable) {
        for (const row of old) {
          this.db
            .prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?')
            .run(row.chunk_id);
        }
      }
      this.db
        .prepare(
          'DELETE FROM knowledge_chunks WHERE workspace_id=? AND document_id=?',
        )
        .run(workspaceId, documentId);
      const insert = this.db.prepare(
        `INSERT INTO knowledge_chunks (
           workspace_id, chunk_id, document_id, page, printed_page, section,
           text, models_json, version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = ftsAvailable
        ? this.db.prepare(
            'INSERT INTO knowledge_chunks_fts (chunk_id, text, section) VALUES (?, ?, ?)',
          )
        : null;
      for (const chunk of chunks) {
        insert.run(
          workspaceId,
          chunk.chunkId,
          documentId,
          chunk.page,
          chunk.printedPage,
          chunk.section,
          chunk.text,
          JSON.stringify(chunk.models),
          chunk.version,
          nowIso(),
        );
        insertFts?.run(chunk.chunkId, chunk.text, chunk.section ?? '');
      }
    })();
  }

  getDocument(
    workspaceId: string,
    documentId: string,
  ): KnowledgeHit['document'] | null {
    const row = this.db
      .prepare(
        'SELECT * FROM knowledge_documents WHERE workspace_id=? AND document_id=?',
      )
      .get(workspaceId, documentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapDocument(row);
  }

  listDocuments(workspaceId: string): KnowledgeHit['document'][] {
    const rows = this.db
      .prepare(
        'SELECT * FROM knowledge_documents WHERE workspace_id=? ORDER BY document_id',
      )
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => this.mapDocument(row));
  }

  private mapDocument(row: Record<string, unknown>): KnowledgeHit['document'] {
    return {
      document_id: String(row.document_id),
      title: String(row.title),
      vendor: String(row.vendor),
      model: String(row.model),
      manual_version: String(row.manual_version),
      effective_date: (row.effective_date as string | null) ?? null,
      file_hash: String(row.file_hash),
      file_path: String(row.file_path),
      withdrawn: toBool(row.withdrawn),
    };
  }

  withdrawDocument(workspaceId: string, documentId: string): void {
    this.db
      .prepare(
        'UPDATE knowledge_documents SET withdrawn=1 WHERE workspace_id=? AND document_id=?',
      )
      .run(workspaceId, documentId);
  }

  setDocumentWithdrawn(
    workspaceId: string,
    documentId: string,
    withdrawn: boolean,
  ): void {
    this.db
      .prepare(
        'UPDATE knowledge_documents SET withdrawn=? WHERE workspace_id=? AND document_id=?',
      )
      .run(withdrawn ? 1 : 0, workspaceId, documentId);
  }

  searchChunks(input: {
    workspaceId: string;
    query: string;
    model?: string;
    version?: string;
    limit?: number;
    ftsAvailable: boolean;
    excludeDocuments?: string[];
  }): KnowledgeHit[] {
    const limit = Math.min(input.limit ?? 5, 20);
    const filters: string[] = ['d.workspace_id = ?', 'd.withdrawn = 0'];
    const params: unknown[] = [input.workspaceId];
    if (input.model) {
      filters.push('d.model = ?');
      params.push(input.model);
    }
    if (input.version) {
      filters.push('d.manual_version = ?');
      params.push(input.version);
    }
    if (input.excludeDocuments && input.excludeDocuments.length > 0) {
      filters.push(
        `d.document_id NOT IN (${input.excludeDocuments.map(() => '?').join(',')})`,
      );
      params.push(...input.excludeDocuments);
    }
    const rows: Record<string, unknown>[] = [];
    const useFts =
      input.ftsAvailable &&
      input.query.trim().length >= 3 &&
      /[\p{L}\p{N}]/u.test(input.query);
    if (useFts) {
      const terms = input.query
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replaceAll('"', '""')}"`)
        .join(' AND ');
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT c.*, d.*, bm25(knowledge_chunks_fts) AS rank
             FROM knowledge_chunks_fts f
             JOIN knowledge_chunks c ON c.chunk_id = f.chunk_id
             JOIN knowledge_documents d
               ON d.document_id = c.document_id AND d.workspace_id = c.workspace_id
             WHERE knowledge_chunks_fts MATCH ? AND ${filters.join(' AND ')}
             ORDER BY rank ASC LIMIT ?`,
          )
          .all(terms, ...params, limit) as Record<string, unknown>[];
        rows.push(...ftsRows);
      } catch {
        // MATCH 语法或 tokenizer 不兼容时回退 LIKE
      }
    }
    if (rows.length === 0) {
      // FTS5 trigram 对 1-2 个汉字无法建 token；中文查询回退到逐词 LIKE，
      // 否则“轴承 温度”这类检索会整串匹配失败。
      const rawTokens = input.query
        .split(/[\s,，。;；、/]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2);
      const tokens: string[] = [];
      for (const token of rawTokens) {
        // 无空格中文长词（如“轴承温度传感器漂移”）整串既不是 FTS token，
        // LIKE 也匹配不到连续原文；退化为双字窗口，保留检索召回。
        if (/^\p{Script=Han}+$/u.test(token) && token.length > 4) {
          for (let index = 0; index < token.length - 1; index += 1) {
            tokens.push(token.slice(index, index + 2));
          }
        } else {
          tokens.push(token);
        }
      }
      const effective =
        tokens.length > 0
          ? [...new Set(tokens)].slice(0, 8)
          : [input.query.trim()];
      const clause = effective
        .map(() => '(c.text LIKE ? OR c.section LIKE ?)')
        .join(' OR ');
      const likeParams = effective.flatMap((token) => [
        `%${token}%`,
        `%${token}%`,
      ]);
      const likeRows = this.db
        .prepare(
          `SELECT c.*, d.*, 0 AS rank
           FROM knowledge_chunks c
           JOIN knowledge_documents d
             ON d.document_id = c.document_id AND d.workspace_id = c.workspace_id
           WHERE ${filters.join(' AND ')} AND (${clause})
           ORDER BY c.page ASC LIMIT ?`,
        )
        .all(...params, ...likeParams, Math.min(40, limit * 4)) as Record<
        string,
        unknown
      >[];
      const scored = likeRows.map((row) => {
        const hay = `${String(row.text)} ${String(row.section ?? '')}`;
        const hits = effective.filter((token) => hay.includes(token)).length;
        return { row, hits };
      });
      scored.sort((a, b) => b.hits - a.hits);
      rows.push(...scored.slice(0, limit).map((item) => item.row));
    }
    const seen = new Set<string>();
    return rows
      .filter((row) => {
        const id = String(row.chunk_id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((row) => ({
        document: this.mapDocument(row),
        chunk: {
          chunk_id: String(row.chunk_id),
          page: Number(row.page),
          printed_page: (row.printed_page as string | null) ?? null,
          section: (row.section as string | null) ?? null,
          text: String(row.text),
        },
        score: Math.max(0, -Number(row.rank ?? 0)) + 1,
      }));
  }

  getChunk(
    workspaceId: string,
    documentId: string,
    chunkId?: string,
    page?: number,
  ): KnowledgeHit | null {
    const conditions = ['c.workspace_id = ?', 'c.document_id = ?'];
    const params: unknown[] = [workspaceId, documentId];
    if (chunkId) {
      conditions.push('c.chunk_id = ?');
      params.push(chunkId);
    }
    if (page) {
      conditions.push('c.page = ?');
      params.push(page);
    }
    const row = this.db
      .prepare(
        `SELECT c.*, d.* FROM knowledge_chunks c
         JOIN knowledge_documents d
           ON d.document_id = c.document_id AND d.workspace_id = c.workspace_id
         WHERE ${conditions.join(' AND ')} LIMIT 1`,
      )
      .get(...params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      document: this.mapDocument(row),
      chunk: {
        chunk_id: String(row.chunk_id),
        page: Number(row.page),
        printed_page: (row.printed_page as string | null) ?? null,
        section: (row.section as string | null) ?? null,
        text: String(row.text),
      },
      score: 1,
    };
  }

  // -------------------------------------------------------------------------
  // Context manifests / eval
  // -------------------------------------------------------------------------

  listManifests(runId: string): ContextManifest[] {
    const rows = this.db
      .prepare(
        `SELECT manifest_json FROM diagnosis_context_manifests
         WHERE run_id = ? ORDER BY created_at ASC`,
      )
      .all(runId) as Array<{ manifest_json: string }>;
    return rows.map((row) =>
      parseJson(row.manifest_json, null as unknown as ContextManifest),
    );
  }

  saveManifest(manifest: ContextManifest): void {
    this.db
      .prepare(
        `INSERT INTO diagnosis_context_manifests
         (id, run_id, role, stage, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('ctx'),
        manifest.run_id,
        manifest.role,
        manifest.stage,
        JSON.stringify(manifest),
        nowIso(),
      );
  }

  createEvalRun(input: { id: string; mode: string; split: string }): void {
    this.db
      .prepare(
        `INSERT INTO diagnosis_eval_runs (id, mode, split, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(input.id, input.mode, input.split, nowIso());
  }

  finishEvalRun(input: {
    id: string;
    status: string;
    metrics: EvalMetrics;
    results: unknown[];
    error?: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE diagnosis_eval_runs
         SET status=?, finished_at=?, metrics_json=?, results_json=?, error=?
         WHERE id=?`,
      )
      .run(
        input.status,
        nowIso(),
        JSON.stringify(input.metrics),
        JSON.stringify(input.results),
        input.error ?? null,
        input.id,
      );
  }

  getEvalRun(id: string): Record<string, unknown> | null {
    const row = this.db
      .prepare('SELECT * FROM diagnosis_eval_runs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...row,
      metrics: parseJson(row.metrics_json as string | null, null),
      results: parseJson(row.results_json as string | null, null),
    };
  }

  listEvalRuns(limit = 20): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        'SELECT * FROM diagnosis_eval_runs ORDER BY started_at DESC LIMIT ?',
      )
      .all(limit) as Array<Record<string, unknown>>;
  }
}

export type { ToolError };
