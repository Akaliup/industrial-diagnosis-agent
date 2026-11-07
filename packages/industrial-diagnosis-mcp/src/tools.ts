import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { McpConfig } from './config.js';
import {
  CaseSearchInputSchema,
  EquipmentQueryInputSchema,
  EquipmentResolveInputSchema,
  EvidenceGetInputSchema,
  ManualSearchInputSchema,
  ManualSectionInputSchema,
  ToolResponseEnvelopeSchema,
  type ToolResponseEnvelope,
} from './contracts/domain.js';
import type { DiagnosisAdapter, ToolResult } from './adapters/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: AnySchema;
  run: (args: unknown) => Promise<ToolResponseEnvelope>;
}

function envelope(
  config: McpConfig,
  result: ToolResult<unknown>,
): ToolResponseEnvelope {
  const candidate: ToolResponseEnvelope = {
    schema_version: '1',
    request_id: `req_${crypto.randomUUID()}`,
    logical_call_id: `lc_${crypto.randomUUID()}`,
    data_mode: config.dataMode,
    status: result.status,
    data: result.data,
    evidence: result.evidence,
    coverage: result.coverage,
    warnings: result.warnings,
    error: result.error,
    next_cursor: result.next_cursor,
  };
  const parsed = ToolResponseEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    const message = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return {
      ...candidate,
      status: 'error',
      data: null,
      evidence: [],
      warnings: [],
      error: {
        code: 'SCHEMA_MISMATCH',
        retryable: false,
        safe_message: `工具返回不符合协议：${message}`,
      },
    };
  }
  return parsed.data as ToolResponseEnvelope;
}

function appendCallLog(
  config: McpConfig,
  entry: Record<string, unknown>,
): void {
  if (!config.callLog) return;
  try {
    fs.mkdirSync(path.dirname(config.callLog), { recursive: true });
    fs.appendFileSync(config.callLog, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(
      `[diagnosis-mcp] call log write failed: ${String(error)}\n`,
    );
  }
}

function makeRunner(
  config: McpConfig,
  name: string,
  schema: {
    safeParse: (value: unknown) =>
      | { success: true; data: unknown }
      | {
          success: false;
          error: { issues: Array<{ path: PropertyKey[]; message: string }> };
        };
  },
  invoke: (args: never) => Promise<ToolResult<unknown>>,
): (raw: unknown) => Promise<ToolResponseEnvelope> {
  return async (raw: unknown) => {
    const started = Date.now();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      const result: ToolResult<unknown> = {
        status: 'error',
        data: null,
        evidence: [],
        coverage: {
          from: config.now,
          to: config.now,
          complete: false,
          missing: ['INVALID_ARGUMENT'],
        },
        warnings: [],
        error: {
          code: 'INVALID_ARGUMENT',
          retryable: false,
          safe_message: message,
        },
        next_cursor: null,
      };
      const env = envelope(config, result);
      appendCallLog(config, {
        ts: new Date().toISOString(),
        tool: name,
        args: raw,
        status: env.status,
        error_code: env.error?.code ?? null,
        evidence_count: 0,
        duration_ms: Date.now() - started,
      });
      return env;
    }
    const result = await invoke(parsed.data as never);
    const env = envelope(config, result);
    appendCallLog(config, {
      ts: new Date().toISOString(),
      tool: name,
      args: raw,
      status: env.status,
      error_code: env.error?.code ?? null,
      evidence_count: env.evidence.length,
      duration_ms: Date.now() - started,
    });
    return env;
  };
}

export function createToolDefinitions(
  config: McpConfig,
  adapter: DiagnosisAdapter,
): ToolDefinition[] {
  return [
    {
      name: 'equipment_resolve',
      description:
        '只读解析设备编号/序列号/名称，返回唯一资产映射。多解返回 AMBIGUOUS_EQUIPMENT。',
      schema: EquipmentResolveInputSchema,
      run: makeRunner(
        config,
        'equipment_resolve',
        EquipmentResolveInputSchema,
        (args) => adapter.resolveEquipment(args),
      ),
    },
    {
      name: 'equipment_query',
      description:
        '只读查询设备 status/telemetry/alarms/mes_events/work_orders。时间窗 UTC 半开区间，最多 24 小时。',
      schema: EquipmentQueryInputSchema,
      run: makeRunner(
        config,
        'equipment_query',
        EquipmentQueryInputSchema,
        (args) => adapter.query(args),
      ),
    },
    {
      name: 'maintenance_search_manual',
      description: '只读检索维修手册条款，按机型/版本过滤，返回页码与摘录。',
      schema: ManualSearchInputSchema,
      run: makeRunner(
        config,
        'maintenance_search_manual',
        ManualSearchInputSchema,
        (args) => adapter.searchManual(args),
      ),
    },
    {
      name: 'maintenance_get_manual_section',
      description: '只读读取指定手册条款的完整摘录与页码定位。',
      schema: ManualSectionInputSchema,
      run: makeRunner(
        config,
        'maintenance_get_manual_section',
        ManualSectionInputSchema,
        (args) => adapter.getManualSection(args),
      ),
    },
    {
      name: 'maintenance_search_cases',
      description:
        '只读检索历史维修案例。历史相似性不等于本次根因，必须结合本次证据。',
      schema: CaseSearchInputSchema,
      run: makeRunner(
        config,
        'maintenance_search_cases',
        CaseSearchInputSchema,
        (args) => adapter.searchCases(args),
      ),
    },
    {
      name: 'evidence_get',
      description: '按证据 ID 读取当前 Run 已返回的原始证据。',
      schema: EvidenceGetInputSchema,
      run: makeRunner(config, 'evidence_get', EvidenceGetInputSchema, (args) =>
        adapter.getEvidence(
          (args as unknown as { evidence_ids: string[] }).evidence_ids,
        ),
      ),
    },
  ];
}
