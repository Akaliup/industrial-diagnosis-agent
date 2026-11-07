import fs from 'node:fs';
import path from 'node:path';
import type {
  ErrorCode,
  QualityFlag,
  RootCauseCode,
} from './contracts/domain.js';
import type { McpConfig } from './config.js';

export class ToolFailure extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export interface EquipmentRecord {
  equipment_id: string;
  name: string;
  vendor: string;
  model: string;
  serial: string;
  asset_category: string;
  source_ids: Record<string, string>;
  metrics: Record<
    string,
    {
      unit: string;
      normalized_unit?: string;
      normal_range?: [number, number];
    }
  >;
}

export interface TelemetryPoint {
  t: string;
  v: number;
  q: QualityFlag;
}

export interface AlarmRecord {
  source_id: string;
  source_alarm_id: string;
  equipment_id: string;
  code: string;
  severity: string;
  state: 'active' | 'cleared' | 'unknown';
  raised_at: string;
  cleared_at: string | null;
  message: string;
}

export interface MesEventRecord {
  source_id: string;
  event_id: string;
  equipment_id: string;
  event_type: string;
  occurred_at: string;
  summary: string;
  work_order_id: string | null;
}

export interface WorkOrderRecord {
  source_id: string;
  work_order_id: string;
  equipment_id: string;
  title: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  root_cause_code: RootCauseCode | null;
  summary: string;
}

export interface ManualDocumentRecord {
  document_id: string;
  title: string;
  vendor: string;
  model: string;
  manual_version: string;
  effective_date: string | null;
  file_hash: string;
  file: string;
  withdrawn?: boolean;
}

export interface ManualChunkRecord {
  document_id: string;
  chunk_id: string;
  page: number;
  printed_page: string | null;
  section: string | null;
  text: string;
  models: string[];
  version: string;
}

export interface CaseRecord {
  case_id: string;
  title: string;
  equipment_model: string;
  asset_category: string;
  occurred_at: string;
  root_cause_code: RootCauseCode;
  summary: string;
}

interface FixtureFiles {
  equipment: { equipment: EquipmentRecord[] };
  telemetry: { series: Record<string, Record<string, TelemetryPoint[]>> };
  alarms: { alarms: AlarmRecord[] };
  mes: { events: MesEventRecord[] };
  work_orders: { work_orders: WorkOrderRecord[] };
  manuals: { documents: ManualDocumentRecord[]; chunks: ManualChunkRecord[] };
  cases: { cases: CaseRecord[] };
}

export interface ScenarioOverlay {
  scenario_id: string;
  clock?: string;
  telemetry?: Record<string, Record<string, TelemetryPoint[]>>;
  alarms?: AlarmRecord[];
  replace_alarms?: boolean;
  mes_events?: MesEventRecord[];
  work_orders?: WorkOrderRecord[];
  fail_sources?: Record<
    string,
    { code: ErrorCode; message: string; retryable?: boolean }
  >;
  unconfigured_sources?: string[];
  withdrawn_documents?: string[];
}

function readJson<T>(file: string): T {
  if (!fs.existsSync(file)) {
    throw new Error(`缺少 fixture 文件：${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function inWindow(t: string, startMs: number, endMs: number): boolean {
  const ms = Date.parse(t);
  return Number.isFinite(ms) && ms >= startMs && ms < endMs;
}

export function scoreText(text: string, query: string): number {
  const hay = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const tokens = new Set<string>();
  for (const token of q.split(/[\s,，。;；、/]+/).filter(Boolean)) {
    tokens.add(token);
  }
  // 中文查询常无空格：补充 2-gram，保证 FTS 之外的 mock 检索也能命中。
  if (tokens.size === 1) {
    const single = [...tokens][0] ?? '';
    const chars = [...single];
    if (chars.length >= 2 && /[一-鿿]/.test(single)) {
      for (let i = 0; i < chars.length - 1; i += 1) {
        tokens.add(chars[i] + chars[i + 1]);
      }
    }
  }
  let hits = 0;
  for (const token of tokens) {
    if (hay.includes(token)) hits += 1;
  }
  return hits / Math.max(1, tokens.size);
}

export class FixtureStore {
  readonly config: McpConfig;
  readonly equipment: EquipmentRecord[];
  readonly series: Record<string, Record<string, TelemetryPoint[]>>;
  readonly alarms: AlarmRecord[];
  readonly mesEvents: MesEventRecord[];
  readonly workOrders: WorkOrderRecord[];
  readonly documents: ManualDocumentRecord[];
  readonly chunks: ManualChunkRecord[];
  readonly cases: CaseRecord[];
  readonly overlay: ScenarioOverlay | null;
  readonly clock: string;

  constructor(config: McpConfig) {
    this.config = config;
    const dir = config.fixturesDir;
    const files: FixtureFiles = {
      equipment: readJson(path.join(dir, 'sources/equipment.json')),
      telemetry: readJson(path.join(dir, 'sources/telemetry.json')),
      alarms: readJson(path.join(dir, 'sources/alarms.json')),
      mes: readJson(path.join(dir, 'sources/mes.json')),
      work_orders: readJson(path.join(dir, 'sources/work_orders.json')),
      manuals: readJson(path.join(dir, 'manuals/manuals.json')),
      cases: readJson(path.join(dir, 'cases/cases.json')),
    };
    this.equipment = files.equipment.equipment;
    this.series = structuredClone(files.telemetry.series);
    this.alarms = structuredClone(files.alarms.alarms);
    this.mesEvents = structuredClone(files.mes.events);
    this.workOrders = structuredClone(files.work_orders.work_orders);
    this.documents = structuredClone(files.manuals.documents);
    this.chunks = structuredClone(files.manuals.chunks);
    this.cases = structuredClone(files.cases.cases);

    if (config.scenarioId) {
      const overlayPath = path.join(
        dir,
        'scenarios',
        `${config.scenarioId}.json`,
      );
      if (!fs.existsSync(overlayPath)) {
        throw new Error(`场景覆盖文件不存在：${overlayPath}`);
      }
      this.overlay = readJson<ScenarioOverlay>(overlayPath);
      this.applyOverlay(this.overlay);
      this.clock = this.overlay.clock ?? config.now;
    } else {
      this.overlay = null;
      this.clock = config.now;
    }
  }

  private applyOverlay(overlay: ScenarioOverlay): void {
    if (overlay.telemetry) {
      for (const [equipmentId, metrics] of Object.entries(overlay.telemetry)) {
        this.series[equipmentId] ??= {};
        for (const [metric, points] of Object.entries(metrics)) {
          this.series[equipmentId][metric] = points;
        }
      }
    }
    if (overlay.alarms) {
      if (overlay.replace_alarms) this.alarms.length = 0;
      this.alarms.push(...overlay.alarms);
    }
    if (overlay.mes_events) this.mesEvents.push(...overlay.mes_events);
    if (overlay.work_orders) this.workOrders.push(...overlay.work_orders);
    if (overlay.withdrawn_documents) {
      for (const doc of this.documents) {
        if (overlay.withdrawn_documents.includes(doc.document_id)) {
          doc.withdrawn = true;
        }
      }
    }
  }

  assertSourceAllowed(sourceId: string): void {
    if (
      this.config.sourceAllowlist &&
      !this.config.sourceAllowlist.includes(sourceId)
    ) {
      throw new ToolFailure('FORBIDDEN', `来源 ${sourceId} 不在本次允许清单内`);
    }
  }

  assertSourceHealthy(
    kind: 'scada' | 'rootcloud' | 'mes' | 'work_order',
  ): void {
    const overlay = this.overlay;
    if (!overlay) return;
    if (overlay.unconfigured_sources?.includes(kind)) {
      throw new ToolFailure('UNCONFIGURED', `来源 ${kind} 未配置`);
    }
    const failure = overlay.fail_sources?.[kind];
    if (failure) {
      throw new ToolFailure(
        failure.code,
        failure.message,
        failure.retryable ?? failure.code === 'TIMEOUT',
      );
    }
  }

  resolveEquipment(
    query: string,
    vendor?: string,
    model?: string,
  ): EquipmentRecord[] {
    const q = query.trim().toLowerCase();
    return this.equipment.filter((e) => {
      if (vendor && e.vendor !== vendor) return false;
      if (model && e.model !== model) return false;
      return (
        e.equipment_id.toLowerCase() === q ||
        e.serial.toLowerCase() === q ||
        e.name.toLowerCase().includes(q) ||
        e.equipment_id.toLowerCase().includes(q)
      );
    });
  }

  getEquipment(equipmentId: string): EquipmentRecord {
    const found = this.equipment.find((e) => e.equipment_id === equipmentId);
    if (!found)
      throw new ToolFailure('NOT_FOUND', `设备 ${equipmentId} 不存在`);
    return found;
  }

  getSeries(equipmentId: string, metric: string): TelemetryPoint[] {
    return this.series[equipmentId]?.[metric] ?? [];
  }

  queryTelemetry(
    equipmentId: string,
    metrics: string[],
    start: string,
    end: string,
    limit: number,
  ): {
    series: Array<{ metric: string; unit: string; points: TelemetryPoint[] }>;
    stats: Array<{
      metric: string;
      unit: string;
      min: number;
      max: number;
      avg: number;
      count: number;
      missing: number;
    }>;
    truncated: boolean;
    missingMetrics: string[];
  } {
    const equipment = this.getEquipment(equipmentId);
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    let remaining = limit;
    const series: Array<{
      metric: string;
      unit: string;
      points: TelemetryPoint[];
    }> = [];
    const stats: Array<{
      metric: string;
      unit: string;
      min: number;
      max: number;
      avg: number;
      count: number;
      missing: number;
    }> = [];
    const missingMetrics: string[] = [];
    let truncated = false;
    for (const metric of metrics) {
      const meta = equipment.metrics[metric];
      if (!meta) {
        throw new ToolFailure(
          'INVALID_ARGUMENT',
          `指标 ${metric} 不在设备 ${equipmentId} 的白名单内`,
        );
      }
      const all = this.getSeries(equipmentId, metric).filter((p) =>
        inWindow(p.t, startMs, endMs),
      );
      if (all.length === 0) missingMetrics.push(metric);
      const points = all.slice(0, Math.max(0, remaining));
      if (points.length < all.length) truncated = true;
      remaining -= points.length;
      series.push({ metric, unit: meta.unit, points });
      const values = points.filter((p) => p.q !== 'missing').map((p) => p.v);
      stats.push({
        metric,
        unit: meta.unit,
        min: values.length ? Math.min(...values) : 0,
        max: values.length ? Math.max(...values) : 0,
        avg: values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : 0,
        count: values.length,
        missing: points.filter((p) => p.q === 'missing').length,
      });
    }
    return { series, stats, truncated, missingMetrics };
  }

  queryStatus(
    equipmentId: string,
    end: string,
  ): {
    equipment: EquipmentRecord;
    points: Array<{
      metric: string;
      value: number;
      unit: string;
      at: string;
      quality: QualityFlag;
    }>;
  } {
    const equipment = this.getEquipment(equipmentId);
    const endMs = Date.parse(end);
    const points: Array<{
      metric: string;
      value: number;
      unit: string;
      at: string;
      quality: QualityFlag;
    }> = [];
    for (const metric of Object.keys(equipment.metrics)) {
      const candidates = this.getSeries(equipmentId, metric).filter(
        (p) => Date.parse(p.t) <= endMs,
      );
      const latest = candidates[candidates.length - 1];
      if (latest) {
        points.push({
          metric,
          value: latest.v,
          unit: equipment.metrics[metric].unit,
          at: latest.t,
          quality: latest.q,
        });
      }
    }
    return { equipment, points };
  }

  queryAlarms(equipmentId: string, start: string, end: string): AlarmRecord[] {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    return this.alarms.filter((a) => {
      if (a.equipment_id !== equipmentId) return false;
      const raised = Date.parse(a.raised_at);
      const cleared = a.cleared_at ? Date.parse(a.cleared_at) : null;
      return raised < endMs && (cleared === null || cleared >= startMs);
    });
  }

  queryMes(equipmentId: string, start: string, end: string): MesEventRecord[] {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    return this.mesEvents.filter(
      (e) =>
        e.equipment_id === equipmentId &&
        inWindow(e.occurred_at, startMs, endMs),
    );
  }

  queryWorkOrders(
    equipmentId: string,
    start: string,
    end: string,
  ): WorkOrderRecord[] {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    return this.workOrders.filter((o) => {
      if (o.equipment_id !== equipmentId) return false;
      const opened = Date.parse(o.opened_at);
      const closed = o.closed_at ? Date.parse(o.closed_at) : null;
      return opened < endMs && (closed === null || closed >= startMs);
    });
  }

  searchManual(
    query: string,
    equipmentModel?: string,
    manualVersion?: string,
    limit = 5,
  ): Array<{
    document: ManualDocumentRecord;
    chunk: ManualChunkRecord;
    score: number;
  }> {
    const results: Array<{
      document: ManualDocumentRecord;
      chunk: ManualChunkRecord;
      score: number;
    }> = [];
    for (const chunk of this.chunks) {
      const doc = this.documents.find(
        (d) => d.document_id === chunk.document_id,
      );
      if (!doc || doc.withdrawn) continue;
      if (equipmentModel && !chunk.models.includes(equipmentModel)) continue;
      if (manualVersion && doc.manual_version !== manualVersion) continue;
      const score = scoreText(
        `${doc.title} ${chunk.section ?? ''} ${chunk.text}`,
        query,
      );
      if (score > 0) results.push({ document: doc, chunk, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  getManualSection(
    documentId: string,
    chunkId?: string,
    page?: number,
  ): { document: ManualDocumentRecord; chunk: ManualChunkRecord } {
    const doc = this.documents.find((d) => d.document_id === documentId);
    if (!doc) throw new ToolFailure('NOT_FOUND', `手册 ${documentId} 不存在`);
    if (doc.withdrawn) {
      throw new ToolFailure('NOT_FOUND', `手册 ${documentId} 已撤回`);
    }
    const chunk = this.chunks.find(
      (c) =>
        c.document_id === documentId &&
        (chunkId ? c.chunk_id === chunkId : true) &&
        (page ? c.page === page : true),
    );
    if (!chunk) throw new ToolFailure('NOT_FOUND', '未找到对应手册条款');
    return { document: doc, chunk };
  }

  searchCases(
    query: string,
    equipmentModel?: string,
    assetCategory?: string,
    limit = 5,
  ): Array<{ record: CaseRecord; score: number }> {
    const results: Array<{ record: CaseRecord; score: number }> = [];
    for (const record of this.cases) {
      if (equipmentModel && record.equipment_model !== equipmentModel) continue;
      if (assetCategory && record.asset_category !== assetCategory) continue;
      const score = scoreText(`${record.title} ${record.summary}`, query);
      if (score > 0) results.push({ record, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
