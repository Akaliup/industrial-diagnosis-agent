import type {
  AlarmsData,
  CaseSearchData,
  CaseSearchInput,
  Coverage,
  EquipmentQueryInput,
  EquipmentResolveData,
  EquipmentResolveInput,
  EquipmentStatusData,
  EvidenceDraft,
  EvidenceGetData,
  EvidencePayload,
  ManualSearchData,
  ManualSearchInput,
  ManualSectionData,
  ManualSectionInput,
  MesEventsData,
  QualityFlag,
  TelemetryData,
  ToolError,
  WorkOrdersData,
} from '../contracts/domain.js';
import { buildEvidence } from '../evidence.js';
import { FixtureStore, ToolFailure } from '../store.js';
import type {
  AdapterContext,
  DiagnosisAdapter,
  EquipmentQueryData,
  ToolResult,
} from './types.js';

const SCADA = 'src-scada';
const MES = 'src-mes';
const WORK_ORDER = 'src-wo';
const MANUAL = 'src-manual';
const CASE = 'src-case';

export class MockAdapter implements DiagnosisAdapter {
  private readonly evidenceCache = new Map<string, EvidenceDraft>();

  constructor(
    private readonly store: FixtureStore,
    private readonly ctx: AdapterContext,
  ) {}

  private coverage(
    from: string,
    to: string,
    complete = true,
    missing: string[] = [],
  ): Coverage {
    return { from, to, complete, missing };
  }

  private evidence(input: {
    sourceId: string;
    sourceKind: Parameters<typeof buildEvidence>[1]['sourceKind'];
    equipmentId: string | null;
    observedAt: string | null;
    sourceRecordId: string;
    locator: Parameters<typeof buildEvidence>[1]['locator'];
    payload: EvidencePayload;
    qualityFlags?: QualityFlag[];
    query: unknown;
  }): EvidenceDraft {
    const ev = buildEvidence(
      {
        workspaceId: this.ctx.workspaceId,
        runId: this.ctx.runId,
        dataMode: this.ctx.dataMode,
        query: input.query,
      },
      input,
    );
    this.evidenceCache.set(ev.id, ev);
    return ev;
  }

  private fail<T>(
    code: ToolError['code'],
    message: string,
    retryable: boolean,
    from: string,
    to: string,
  ): ToolResult<T> {
    return {
      status: 'error',
      data: null,
      evidence: [],
      coverage: this.coverage(from, to, false, [code]),
      warnings: [],
      error: { code, retryable, safe_message: message },
      next_cursor: null,
    };
  }

  private fromError<T>(
    error: unknown,
    from: string,
    to: string,
  ): ToolResult<T> {
    if (error instanceof ToolFailure) {
      return this.fail(error.code, error.message, error.retryable, from, to);
    }
    const message = error instanceof Error ? error.message : String(error);
    return this.fail('SOURCE_UNAVAILABLE', message, true, from, to);
  }

  async resolveEquipment(
    input: EquipmentResolveInput,
  ): Promise<ToolResult<EquipmentResolveData>> {
    const now = this.ctx.now;
    try {
      const matches = this.store.resolveEquipment(
        input.query,
        input.vendor,
        input.model,
      );
      const exact = matches.filter(
        (e) =>
          e.equipment_id.toLowerCase() === input.query.trim().toLowerCase() ||
          e.serial.toLowerCase() === input.query.trim().toLowerCase(),
      );
      const chosen = exact.length === 1 ? exact : matches;
      if (chosen.length === 0) {
        return this.fail(
          'NOT_FOUND',
          `未找到设备：${input.query}`,
          false,
          now,
          now,
        );
      }
      if (chosen.length > 1) {
        return this.fail(
          'AMBIGUOUS_EQUIPMENT',
          `设备查询命中 ${chosen.length} 条记录，需要补充序列号或来源系统 ID`,
          false,
          now,
          now,
        );
      }
      const e = chosen[0];
      return {
        status: 'success',
        data: {
          matches: [
            {
              equipment_id: e.equipment_id,
              name: e.name,
              vendor: e.vendor,
              model: e.model,
              serial: e.serial,
              source_ids: e.source_ids,
            },
          ],
          ambiguous: false,
        },
        evidence: [],
        coverage: this.coverage(now, now),
        warnings: [],
        error: null,
        next_cursor: null,
      };
    } catch (error) {
      return this.fromError(error, now, now);
    }
  }

  async query(
    input: EquipmentQueryInput,
  ): Promise<ToolResult<EquipmentQueryData>> {
    const { start, end } = input.window;
    try {
      switch (input.query_kind) {
        case 'status':
          return await this.queryStatus(input);
        case 'telemetry':
          return await this.queryTelemetry(input);
        case 'alarms':
          return await this.queryAlarms(input);
        case 'mes_events':
          return await this.queryMes(input);
        case 'work_orders':
          return await this.queryWorkOrders(input);
        default:
          return this.fail(
            'INVALID_ARGUMENT',
            `未知 query_kind: ${String(input.query_kind)}`,
            false,
            start,
            end,
          );
      }
    } catch (error) {
      return this.fromError(error, start, end);
    }
  }

  private async queryStatus(
    input: EquipmentQueryInput,
  ): Promise<ToolResult<EquipmentStatusData>> {
    this.store.assertSourceAllowed(SCADA);
    this.store.assertSourceHealthy('scada');
    const { equipment, points } = this.store.queryStatus(
      input.equipment_id,
      input.window.end,
    );
    if (points.length === 0) {
      return {
        status: 'no_data',
        data: null,
        evidence: [],
        coverage: this.coverage(input.window.start, input.window.end, false, [
          'status',
        ]),
        warnings: [{ code: 'NO_STATUS', message: '时间窗内没有状态快照' }],
        error: null,
        next_cursor: null,
      };
    }
    const lastSeen =
      points
        .map((p) => p.at)
        .sort()
        .at(-1) ?? null;
    const activeAlarm = this.store
      .queryAlarms(input.equipment_id, input.window.start, input.window.end)
      .some((a) => a.state === 'active');
    const quality: QualityFlag[] = points.every((p) => p.quality === 'good')
      ? ['good']
      : ['low_quality'];
    const ev = this.evidence({
      sourceId: SCADA,
      sourceKind: 'scada',
      equipmentId: equipment.equipment_id,
      observedAt: lastSeen,
      sourceRecordId: `status:${equipment.equipment_id}:${lastSeen ?? 'none'}`,
      locator: { kind: 'db', ref: `status/${equipment.equipment_id}` },
      payload: {
        kind: 'status_snapshot',
        equipment_id: equipment.equipment_id,
        state: activeAlarm ? 'alarm' : 'running',
        mode: null,
        last_seen: lastSeen,
        points,
      },
      qualityFlags: quality,
      query: input,
    });
    return {
      status: 'success',
      data: {
        equipment_id: equipment.equipment_id,
        state: activeAlarm ? 'alarm' : 'running',
        mode: null,
        last_seen: lastSeen,
        points,
      },
      evidence: [ev],
      coverage: this.coverage(input.window.start, input.window.end),
      warnings: [],
      error: null,
      next_cursor: null,
    };
  }

  private async queryTelemetry(
    input: EquipmentQueryInput,
  ): Promise<ToolResult<TelemetryData>> {
    this.store.assertSourceAllowed(SCADA);
    this.store.assertSourceHealthy('scada');
    const equipment = this.store.getEquipment(input.equipment_id);
    const metrics =
      input.metrics && input.metrics.length > 0
        ? input.metrics
        : Object.keys(equipment.metrics).slice(0, 8);
    const limit = input.limit ?? 1000;
    const result = this.store.queryTelemetry(
      input.equipment_id,
      metrics,
      input.window.start,
      input.window.end,
      limit,
    );
    const evidence: EvidenceDraft[] = [];
    for (const series of result.series) {
      if (series.points.length === 0) continue;
      const stat = result.stats.find((s) => s.metric === series.metric)!;
      evidence.push(
        this.evidence({
          sourceId: SCADA,
          sourceKind: 'scada',
          equipmentId: input.equipment_id,
          observedAt: series.points.at(-1)?.t ?? null,
          sourceRecordId: `telemetry:${input.equipment_id}:${series.metric}:${input.window.start}:${input.window.end}`,
          locator: {
            kind: 'db',
            ref: `telemetry/${input.equipment_id}/${series.metric}`,
          },
          payload: {
            kind: 'telemetry_series',
            equipment_id: input.equipment_id,
            metric: series.metric,
            unit: series.unit,
            points: series.points,
            stats: {
              min: stat.min,
              max: stat.max,
              avg: stat.avg,
              count: stat.count,
              missing: stat.missing,
            },
          },
          qualityFlags: series.points.every((p) => p.q === 'good')
            ? ['good']
            : ['low_quality'],
          query: input,
        }),
      );
    }
    const hasAny = result.series.some((s) => s.points.length > 0);
    if (!hasAny) {
      return {
        status: 'no_data',
        data: null,
        evidence: [],
        coverage: this.coverage(
          input.window.start,
          input.window.end,
          false,
          metrics,
        ),
        warnings: [
          { code: 'NO_TELEMETRY', message: '时间窗内没有可用的遥测数据' },
        ],
        error: null,
        next_cursor: null,
      };
    }
    const warnings = [];
    if (result.missingMetrics.length > 0) {
      warnings.push({
        code: 'MISSING_METRICS',
        message: `缺少指标：${result.missingMetrics.join(', ')}`,
      });
    }
    if (result.truncated) {
      warnings.push({
        code: 'TRUNCATED',
        message: `结果超过 ${limit} 点，已截断；coverage.complete=false`,
      });
    }
    const partial = result.truncated || result.missingMetrics.length > 0;
    return {
      status: partial ? 'partial' : 'success',
      data: {
        equipment_id: input.equipment_id,
        series: result.series,
        stats: result.stats,
        truncated: result.truncated,
      },
      evidence,
      coverage: this.coverage(
        input.window.start,
        input.window.end,
        !partial,
        result.missingMetrics,
      ),
      warnings,
      error: null,
      next_cursor: result.truncated
        ? Buffer.from(
            JSON.stringify({ limit, end: input.window.end }),
            'utf8',
          ).toString('base64url')
        : null,
    };
  }

  private async queryAlarms(
    input: EquipmentQueryInput,
  ): Promise<ToolResult<AlarmsData>> {
    this.store.assertSourceAllowed(SCADA);
    this.store.assertSourceHealthy('scada');
    const alarms = this.store.queryAlarms(
      input.equipment_id,
      input.window.start,
      input.window.end,
    );
    if (alarms.length === 0) {
      return {
        status: 'no_data',
        data: null,
        evidence: [],
        coverage: this.coverage(input.window.start, input.window.end),
        warnings: [{ code: 'NO_ALARMS', message: '时间窗内没有报警记录' }],
        error: null,
        next_cursor: null,
      };
    }
    const evidence = alarms.map((a) =>
      this.evidence({
        sourceId: SCADA,
        sourceKind: 'scada',
        equipmentId: input.equipment_id,
        observedAt: a.raised_at,
        sourceRecordId: `alarm:${a.source_alarm_id}`,
        locator: { kind: 'db', ref: `alarms/${a.source_alarm_id}` },
        payload: {
          kind: 'alarm',
          alarm_event_id: a.source_alarm_id,
          code: a.code,
          severity: a.severity,
          state: a.state,
          raised_at: a.raised_at,
          cleared_at: a.cleared_at,
          message: a.message,
        },
        qualityFlags: ['good'],
        query: input,
      }),
    );
    return {
      status: 'success',
      data: {
        equipment_id: input.equipment_id,
        alarms: alarms.map((a) => ({
          alarm_event_id: a.source_alarm_id,
          code: a.code,
          severity: a.severity,
          state: a.state,
          raised_at: a.raised_at,
          cleared_at: a.cleared_at,
          message: a.message,
        })),
      },
      evidence,
      coverage: this.coverage(input.window.start, input.window.end),
      warnings: [],
      error: null,
      next_cursor: null,
    };
  }

  private async queryMes(
    input: EquipmentQueryInput,
  ): Promise<ToolResult<MesEventsData>> {
    this.store.assertSourceAllowed(MES);
    this.store.assertSourceHealthy('mes');
    const events = this.store.queryMes(
      input.equipment_id,
      input.window.start,
      input.window.end,
    );
    if (events.length === 0) {
      return {
        status: 'no_data',
        data: null,
        evidence: [],
        coverage: this.coverage(input.window.start, input.window.end),
        warnings: [{ code: 'NO_MES_EVENTS', message: '时间窗内没有 MES 事件' }],
        error: null,
        next_cursor: null,
      };
    }
    const evidence = events.map((e) =>
      this.evidence({
        sourceId: MES,
        sourceKind: 'mes',
        equipmentId: input.equipment_id,
        observedAt: e.occurred_at,
        sourceRecordId: `mes:${e.event_id}`,
        locator: { kind: 'db', ref: `mes/${e.event_id}` },
        payload: {
          kind: 'mes_event',
          event_id: e.event_id,
          event_type: e.event_type,
          occurred_at: e.occurred_at,
          summary: e.summary,
          work_order_id: e.work_order_id,
        },
        qualityFlags: ['good'],
        query: input,
      }),
    );
    return {
      status: 'success',
      data: {
        equipment_id: input.equipment_id,
        events: events.map((e) => ({
          event_id: e.event_id,
          event_type: e.event_type,
          occurred_at: e.occurred_at,
          summary: e.summary,
          work_order_id: e.work_order_id,
        })),
      },
      evidence,
      coverage: this.coverage(input.window.start, input.window.end),
      warnings: [],
      error: null,
      next_cursor: null,
    };
  }

  private async queryWorkOrders(
    input: EquipmentQueryInput,
  ): Promise<ToolResult<WorkOrdersData>> {
    this.store.assertSourceAllowed(WORK_ORDER);
    this.store.assertSourceHealthy('work_order');
    const orders = this.store.queryWorkOrders(
      input.equipment_id,
      input.window.start,
      input.window.end,
    );
    if (orders.length === 0) {
      return {
        status: 'no_data',
        data: null,
        evidence: [],
        coverage: this.coverage(input.window.start, input.window.end),
        warnings: [{ code: 'NO_WORK_ORDERS', message: '时间窗内没有工单' }],
        error: null,
        next_cursor: null,
      };
    }
    const evidence = orders.map((o) =>
      this.evidence({
        sourceId: WORK_ORDER,
        sourceKind: 'work_order',
        equipmentId: input.equipment_id,
        observedAt: o.opened_at,
        sourceRecordId: `wo:${o.work_order_id}`,
        locator: { kind: 'db', ref: `work_orders/${o.work_order_id}` },
        payload: {
          kind: 'work_order',
          work_order_id: o.work_order_id,
          title: o.title,
          status: o.status,
          opened_at: o.opened_at,
          closed_at: o.closed_at,
          root_cause_code: o.root_cause_code,
          summary: o.summary,
        },
        qualityFlags: ['good'],
        query: input,
      }),
    );
    return {
      status: 'success',
      data: {
        equipment_id: input.equipment_id,
        orders: orders.map((o) => ({
          work_order_id: o.work_order_id,
          title: o.title,
          status: o.status,
          opened_at: o.opened_at,
          closed_at: o.closed_at,
          root_cause_code: o.root_cause_code,
          summary: o.summary,
        })),
      },
      evidence,
      coverage: this.coverage(input.window.start, input.window.end),
      warnings: [],
      error: null,
      next_cursor: null,
    };
  }

  async searchManual(
    input: ManualSearchInput,
  ): Promise<ToolResult<ManualSearchData>> {
    const from = '2000-01-01T00:00:00Z';
    const to = this.ctx.now;
    try {
      this.store.assertSourceAllowed(MANUAL);
      const hits = this.store.searchManual(
        input.query,
        input.equipment_model,
        input.manual_version,
        input.limit ?? 5,
      );
      if (hits.length === 0) {
        return {
          status: 'no_data',
          data: null,
          evidence: [],
          coverage: this.coverage(from, to),
          warnings: [
            {
              code: input.equipment_model
                ? 'NO_COMPATIBLE_MANUAL'
                : 'NO_MANUAL_MATCH',
              message: input.equipment_model
                ? `没有与机型 ${input.equipment_model} 显式兼容的手册条款`
                : '没有匹配的手册条款',
            },
          ],
          error: null,
          next_cursor: null,
        };
      }
      const evidence = hits.map(({ document, chunk, score }) =>
        this.evidence({
          sourceId: MANUAL,
          sourceKind: 'manual',
          equipmentId: null,
          observedAt: document.effective_date
            ? `${document.effective_date}T00:00:00Z`
            : null,
          sourceRecordId: `manual:${document.document_id}:${chunk.chunk_id}`,
          locator: {
            kind: 'file',
            ref: document.file,
            page: chunk.page,
          },
          payload: {
            kind: 'manual_chunk',
            document_id: document.document_id,
            file_hash: document.file_hash,
            vendor: document.vendor,
            model: document.model,
            manual_version: document.manual_version,
            effective_date: document.effective_date,
            chapter: null,
            section: chunk.section,
            pdf_page_index: chunk.page,
            printed_page: chunk.printed_page,
            excerpt: chunk.text,
          },
          qualityFlags: ['good'],
          query: input,
        }),
      );
      const warnings = [];
      if (!input.manual_version) {
        warnings.push({
          code: 'VERSION_UNSPECIFIED',
          message: '未指定手册版本，命中条款需人工确认适用版本',
        });
      }
      return {
        status: input.manual_version ? 'success' : 'partial',
        data: {
          hits: hits.map(({ document, chunk, score }) => ({
            document_id: document.document_id,
            chunk_id: chunk.chunk_id,
            title: document.title,
            vendor: document.vendor,
            model: document.model,
            manual_version: document.manual_version,
            effective_date: document.effective_date,
            page: chunk.page,
            printed_page: chunk.printed_page,
            section: chunk.section,
            excerpt: chunk.text,
            score: Number(score.toFixed(3)),
            file_hash: document.file_hash,
          })),
        },
        evidence,
        coverage: this.coverage(from, to),
        warnings,
        error: null,
        next_cursor: null,
      };
    } catch (error) {
      return this.fromError(error, from, to);
    }
  }

  async getManualSection(
    input: ManualSectionInput,
  ): Promise<ToolResult<ManualSectionData>> {
    const from = '2000-01-01T00:00:00Z';
    const to = this.ctx.now;
    try {
      this.store.assertSourceAllowed(MANUAL);
      const { document, chunk } = this.store.getManualSection(
        input.document_id,
        input.chunk_id,
        input.page,
      );
      const ev = this.evidence({
        sourceId: MANUAL,
        sourceKind: 'manual',
        equipmentId: null,
        observedAt: document.effective_date
          ? `${document.effective_date}T00:00:00Z`
          : null,
        sourceRecordId: `manual:${document.document_id}:${chunk.chunk_id}`,
        locator: { kind: 'file', ref: document.file, page: chunk.page },
        payload: {
          kind: 'manual_chunk',
          document_id: document.document_id,
          file_hash: document.file_hash,
          vendor: document.vendor,
          model: document.model,
          manual_version: document.manual_version,
          effective_date: document.effective_date,
          chapter: null,
          section: chunk.section,
          pdf_page_index: chunk.page,
          printed_page: chunk.printed_page,
          excerpt: chunk.text,
        },
        qualityFlags: ['good'],
        query: input,
      });
      return {
        status: 'success',
        data: {
          document_id: document.document_id,
          chunk_id: chunk.chunk_id,
          title: document.title,
          vendor: document.vendor,
          model: document.model,
          manual_version: document.manual_version,
          effective_date: document.effective_date,
          page: chunk.page,
          printed_page: chunk.printed_page,
          section: chunk.section,
          excerpt: chunk.text,
          file_hash: document.file_hash,
        },
        evidence: [ev],
        coverage: this.coverage(from, to),
        warnings: [],
        error: null,
        next_cursor: null,
      };
    } catch (error) {
      return this.fromError(error, from, to);
    }
  }

  async searchCases(
    input: CaseSearchInput,
  ): Promise<ToolResult<CaseSearchData>> {
    const from = '2000-01-01T00:00:00Z';
    const to = this.ctx.now;
    try {
      this.store.assertSourceAllowed(CASE);
      const hits = this.store.searchCases(
        input.query,
        input.equipment_model,
        input.asset_category,
        input.limit ?? 5,
      );
      if (hits.length === 0) {
        return {
          status: 'no_data',
          data: null,
          evidence: [],
          coverage: this.coverage(from, to),
          warnings: [{ code: 'NO_CASE_MATCH', message: '没有匹配的历史案例' }],
          error: null,
          next_cursor: null,
        };
      }
      const evidence = hits.map(({ record }) =>
        this.evidence({
          sourceId: CASE,
          sourceKind: 'case',
          equipmentId: null,
          observedAt: record.occurred_at,
          sourceRecordId: `case:${record.case_id}`,
          locator: { kind: 'db', ref: `cases/${record.case_id}` },
          payload: {
            kind: 'case_record',
            case_id: record.case_id,
            title: record.title,
            equipment_model: record.equipment_model,
            asset_category: record.asset_category,
            occurred_at: record.occurred_at,
            root_cause_code: record.root_cause_code,
            summary: record.summary,
          },
          qualityFlags: ['good'],
          query: input,
        }),
      );
      return {
        status: 'success',
        data: {
          hits: hits.map(({ record }) => ({
            case_id: record.case_id,
            title: record.title,
            equipment_model: record.equipment_model,
            asset_category: record.asset_category,
            occurred_at: record.occurred_at,
            root_cause_code: record.root_cause_code,
            summary: record.summary,
            similarity_note: '历史相似性不等于本次根因，仅作参考',
          })),
        },
        evidence,
        coverage: this.coverage(from, to),
        warnings: [],
        error: null,
        next_cursor: null,
      };
    } catch (error) {
      return this.fromError(error, from, to);
    }
  }

  async getEvidence(ids: string[]): Promise<ToolResult<EvidenceGetData>> {
    const now = this.ctx.now;
    const found = ids
      .map((id) => this.evidenceCache.get(id))
      .filter((e): e is EvidenceDraft => Boolean(e));
    const missing = ids.filter((id) => !this.evidenceCache.has(id));
    if (found.length === 0) {
      return {
        status: 'no_data',
        data: null,
        evidence: [],
        coverage: this.coverage(now, now),
        warnings: missing.map((id) => ({
          code: 'EVIDENCE_NOT_FOUND',
          message: `证据 ${id} 不在当前 Run 的 MCP 缓存中`,
        })),
        error: null,
        next_cursor: null,
      };
    }
    return {
      status: missing.length > 0 ? 'partial' : 'success',
      data: { evidence: found },
      evidence: [],
      coverage: this.coverage(now, now, missing.length === 0, missing),
      warnings: missing.map((id) => ({
        code: 'EVIDENCE_NOT_FOUND',
        message: `证据 ${id} 不在当前 Run 的 MCP 缓存中`,
      })),
      error: null,
      next_cursor: null,
    };
  }
}
