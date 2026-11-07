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
}

export interface RoleCallResult<T = unknown> {
  output: T;
  mode: ModelMode;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  raw?: string;
}

export interface RoleRunner {
  readonly mode: ModelMode;
  readonly model: string;
  run(input: RoleCallInput): Promise<RoleCallResult>;
  close?(): Promise<void>;
}

export class RoleRunnerError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'UNCONFIGURED'
      | 'MODEL_ERROR'
      | 'INVALID_OUTPUT'
      | 'CANCELLED',
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

export function parseRoleOutput(role: Role, value: unknown): unknown {
  const parsed = schemaFor(role).safeParse(value);
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
