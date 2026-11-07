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
  ManualSearchData,
  ManualSearchInput,
  ManualSectionData,
  ManualSectionInput,
  MesEventsData,
  TelemetryData,
  ToolError,
  WorkOrdersData,
} from '../contracts/domain.js';
import type {
  AdapterContext,
  DiagnosisAdapter,
  EquipmentQueryData,
  ToolResult,
} from './types.js';

/**
 * 通用只读 REST 适配器。
 *
 * 只接受配置中固定的 base URL 与 endpoint 模板；模型不能提供 URL、SQL 或文件路径。
 * 远端必须返回与领域协议一致的数据体；字段映射通过 `config/diagnosis/rest-mapping.json`
 * 的点路径声明，不在代码里猜厂商字段。
 */
export interface RestEndpointConfig {
  resolve: string;
  status: string;
  telemetry: string;
  alarms: string;
  mes_events: string;
  work_orders: string;
}

export interface RestAdapterConfig {
  baseUrl: string;
  token?: string;
  endpoints: RestEndpointConfig;
  timeoutMs?: number;
}

export interface RestMapping {
  /** 远端字段 → 领域字段的点路径；缺省视为同名。 */
  fields?: Record<string, string>;
}

function getByPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

function mapRecord(
  record: Record<string, unknown>,
  mapping: RestMapping | undefined,
): Record<string, unknown> {
  if (!mapping?.fields) return record;
  const out: Record<string, unknown> = { ...record };
  for (const [target, sourcePath] of Object.entries(mapping.fields)) {
    const value = getByPath(record, sourcePath);
    if (value !== undefined) out[target] = value;
  }
  return out;
}

export class RestAdapter implements DiagnosisAdapter {
  constructor(
    private readonly config: RestAdapterConfig,
    private readonly ctx: AdapterContext,
    private readonly mapping?: RestMapping,
  ) {}

  private coverage(from: string, to: string): Coverage {
    return { from, to, complete: true, missing: [] };
  }

  private async request<T>(
    endpoint: string,
    query: Record<string, string | number | undefined>,
    from: string,
    to: string,
  ): Promise<T> {
    const url = new URL(
      endpoint.replace(/\{(\w+)\}/g, (_, key: string) =>
        encodeURIComponent(String(query[key] ?? '')),
      ),
      this.config.baseUrl,
    );
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && !endpoint.includes(`{${key}}`)) {
        url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 10_000,
    );
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(this.config.token
            ? { authorization: `Bearer ${this.config.token}` }
            : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`REST ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private unconfigured<T>(message: string): ToolResult<T> {
    return {
      status: 'error',
      data: null,
      evidence: [],
      coverage: this.coverage(this.ctx.now, this.ctx.now),
      warnings: [],
      error: { code: 'UNCONFIGURED', retryable: false, safe_message: message },
      next_cursor: null,
    };
  }

  async resolveEquipment(
    input: EquipmentResolveInput,
  ): Promise<ToolResult<EquipmentResolveData>> {
    try {
      const raw = await this.request<{ matches?: unknown[] }>(
        this.config.endpoints.resolve,
        { query: input.query, vendor: input.vendor, model: input.model },
        this.ctx.now,
        this.ctx.now,
      );
      const matches = (raw.matches ?? []) as EquipmentResolveData['matches'];
      if (matches.length === 0) {
        return this.unconfigured('REST 来源未返回设备匹配');
      }
      if (matches.length > 1) {
        return {
          status: 'error',
          data: null,
          evidence: [],
          coverage: this.coverage(this.ctx.now, this.ctx.now),
          warnings: [],
          error: {
            code: 'AMBIGUOUS_EQUIPMENT',
            retryable: false,
            safe_message: 'REST 来源返回多条设备匹配',
          },
          next_cursor: null,
        };
      }
      return {
        status: 'success',
        data: { matches, ambiguous: false },
        evidence: [],
        coverage: this.coverage(this.ctx.now, this.ctx.now),
        warnings: [],
        error: null,
        next_cursor: null,
      };
    } catch (error) {
      return this.errorResult(error);
    }
  }

  async query(
    input: EquipmentQueryInput,
  ): Promise<ToolResult<EquipmentQueryData>> {
    const endpoint = this.config.endpoints[input.query_kind];
    if (!endpoint) {
      return this.unconfigured(`REST 未配置 ${input.query_kind} endpoint`);
    }
    try {
      const raw = await this.request<Record<string, unknown>>(
        endpoint,
        {
          equipment_id: input.equipment_id,
          start: input.window.start,
          end: input.window.end,
          metrics: input.metrics?.join(','),
          limit: input.limit,
          cursor: input.cursor,
        },
        input.window.start,
        input.window.end,
      );
      const data = mapRecord(
        raw,
        this.mapping,
      ) as unknown as EquipmentQueryData;
      return {
        status: 'success',
        data,
        evidence: [] as EvidenceDraft[],
        coverage: this.coverage(input.window.start, input.window.end),
        warnings: [
          {
            code: 'EVIDENCE_NOT_INGESTED',
            message: 'REST 适配器未返回可入库证据，需在字段映射中补齐证据载荷',
          },
        ],
        error: null,
        next_cursor: null,
      };
    } catch (error) {
      return this.errorResult(error);
    }
  }

  async searchManual(
    _input: ManualSearchInput,
  ): Promise<ToolResult<ManualSearchData>> {
    return this.unconfigured('手册检索使用本地 FTS，不通过 REST 适配器');
  }

  async getManualSection(
    _input: ManualSectionInput,
  ): Promise<ToolResult<ManualSectionData>> {
    return this.unconfigured('手册检索使用本地 FTS，不通过 REST 适配器');
  }

  async searchCases(
    _input: CaseSearchInput,
  ): Promise<ToolResult<CaseSearchData>> {
    return this.unconfigured('历史案例检索使用本地 FTS，不通过 REST 适配器');
  }

  async getEvidence(_ids: string[]): Promise<ToolResult<EvidenceGetData>> {
    return this.unconfigured('REST 适配器不维护证据缓存，证据由主服务入库');
  }

  private errorResult<T>(error: unknown): ToolResult<T> {
    const message = error instanceof Error ? error.message : String(error);
    const code: ToolError['code'] = /abort/i.test(message)
      ? 'TIMEOUT'
      : 'SOURCE_UNAVAILABLE';
    return {
      status: 'error',
      data: null,
      evidence: [],
      coverage: this.coverage(this.ctx.now, this.ctx.now),
      warnings: [],
      error: {
        code,
        retryable: code === 'TIMEOUT' || code === 'SOURCE_UNAVAILABLE',
        safe_message: message,
      },
      next_cursor: null,
    };
  }
}
