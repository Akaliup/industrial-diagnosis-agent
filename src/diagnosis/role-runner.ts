import {
  DataInvestigatorOutputSchema,
  HypothesisVerifierOutputSchema,
  KnowledgeRetrieverOutputSchema,
  ReportReviewerOutputSchema,
  type AlarmContext,
  type EquipmentSnapshot,
  type Evidence,
  type Hypothesis,
  type ModelMode,
  type Role,
  type Run,
  type Stage,
} from './contracts/domain.js';
import type { BuiltContext, ToolHistoryItem } from './context-builder.js';
import { estimateTokens } from './util.js';

export interface RoleCallLimits {
  /** 本次请求允许的最大输出 token；由 Run 剩余预算决定。 */
  maxOutputTokens: number;
  /** 整个 Run 的绝对截止时间（epoch ms）。 */
  deadlineAt: number;
  /**
   * 在每次额外 HTTP 请求（重试）之前调用；调用方据此预留调用次数。
   * 抛错时必须中止请求，不能继续消耗预算。
   */
  onRequest?: () => void;
}

export interface RoleCallInput {
  run: Run;
  role: Role;
  stage: Stage;
  context: BuiltContext;
  equipment: EquipmentSnapshot;
  alarm: AlarmContext | null;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  toolHistory: ToolHistoryItem[];
  stageRound: number;
  repairIssues?: string[];
  signal?: AbortSignal;
  limits?: RoleCallLimits;
}

export interface RoleCallResult<T = unknown> {
  output: T;
  mode: ModelMode;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  raw?: string;
  /** 实际发出的 HTTP 请求数（含重试）；用于 Run 账本结算。 */
  attempts?: number;
}

export interface RoleRunner {
  readonly mode: ModelMode;
  readonly model: string;
  run(input: RoleCallInput): Promise<RoleCallResult>;
  close?(): Promise<void>;
}

export class RoleRunnerError extends Error {
  /** 失败请求已经产生的 token；无法精确获知时由调用方保守估算。 */
  usage?: { inputTokens: number; outputTokens: number };
  /** 实际发出的 HTTP 请求数（含重试）。 */
  attempts?: number;
  /** 模型原始响应；仅在解析失败时保留，用于失败 Trace 审计。 */
  rawOutput?: string;

  constructor(
    message: string,
    readonly code:
      | 'UNCONFIGURED'
      | 'MODEL_ERROR'
      | 'INVALID_OUTPUT'
      | 'CANCELLED'
      | 'BUDGET_EXCEEDED',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RoleRunnerError';
  }
}

function schemaFor(role: Role) {
  switch (role) {
    case 'data_investigator':
      return DataInvestigatorOutputSchema;
    case 'knowledge_retriever':
      return KnowledgeRetrieverOutputSchema;
    case 'hypothesis_verifier':
      return HypothesisVerifierOutputSchema;
    case 'report_reviewer':
      return ReportReviewerOutputSchema;
  }
}

export function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/**
 * 报告/验证角色偶尔会自造 `status_note_placeholder` 一类的注解字段。
 * 这些字段不参与证据与状态判定，但会触发严格 Schema 失败并迫使整篇
 * 报告重写（长报告重写又可能被 Provider 截断）。这里只归一化
 * `status_note*` 注解：有字符串值则收敛到 status_note，占位/null 直接丢弃；
 * 其他未知字段仍由严格 Schema 拒绝。
 */
function normalizeHypothesisNotes(hypotheses: unknown): void {
  if (!Array.isArray(hypotheses)) return;
  for (const hypothesis of hypotheses) {
    if (!hypothesis || typeof hypothesis !== 'object') continue;
    const item = hypothesis as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (key === 'status_note' || !/^status_note(_|$)/.test(key)) continue;
      const value = item[key];
      if (
        typeof value === 'string' &&
        value.trim() &&
        item.status_note === undefined
      ) {
        item.status_note = value.slice(0, 300);
      }
      delete item[key];
    }
    if (typeof item.status_note === 'string') {
      item.status_note = item.status_note.slice(0, 300);
    } else if (item.status_note !== undefined) {
      delete item.status_note;
    }
  }
}

function normalizeRoleOutput(role: Role, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const root = value as Record<string, unknown>;
  if (role === 'hypothesis_verifier') {
    normalizeHypothesisNotes(root.hypotheses);
  } else if (role === 'report_reviewer') {
    const report = root.report;
    if (report && typeof report === 'object') {
      normalizeHypothesisNotes((report as Record<string, unknown>).hypotheses);
    }
  }
  return value;
}

export function parseRoleOutput(role: Role, value: unknown): unknown {
  const parsed = schemaFor(role).safeParse(normalizeRoleOutput(role, value));
  if (!parsed.success) {
    const message = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new RoleRunnerError(
      `角色 ${role} 输出不符合 Schema：${message}`,
      'INVALID_OUTPUT',
      false,
    );
  }
  return parsed.data;
}

export function parseRoleOutputText(role: Role, raw: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonFences(raw));
  } catch (error) {
    throw new RoleRunnerError(
      `角色 ${role} 输出不是合法 JSON：${
        error instanceof Error ? error.message : String(error)
      }`,
      'INVALID_OUTPUT',
      false,
    );
  }
  return parseRoleOutput(role, value);
}

export function estimateRoleTokens(
  input: RoleCallInput,
  rawOutput: string,
): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: estimateTokens(
      `${input.context.system}\n${input.context.user}`,
    ),
    outputTokens: estimateTokens(rawOutput),
  };
}
