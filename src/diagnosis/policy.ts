import {
  CaseSearchInputSchema,
  EquipmentQueryInputSchema,
  EquipmentResolveInputSchema,
  EvidenceGetInputSchema,
  ManualSearchInputSchema,
  ManualSectionInputSchema,
  type ErrorCode,
  type RiskLevel,
  type Role,
  type Run,
  type ToolName,
} from './contracts/domain.js';
import type { ZodType } from 'zod';

export interface ToolPolicy {
  risk: RiskLevel;
  roles: Role[];
  input: ZodType;
  family: string;
}

export const TOOL_POLICY: Record<ToolName, ToolPolicy> = {
  equipment_resolve: {
    risk: 'read',
    roles: ['data_investigator', 'hypothesis_verifier'],
    input: EquipmentResolveInputSchema,
    family: 'equipment',
  },
  equipment_query: {
    risk: 'read',
    roles: ['data_investigator', 'hypothesis_verifier'],
    input: EquipmentQueryInputSchema,
    family: 'equipment',
  },
  maintenance_search_manual: {
    risk: 'knowledge_read',
    roles: ['knowledge_retriever', 'hypothesis_verifier'],
    input: ManualSearchInputSchema,
    family: 'manual',
  },
  maintenance_get_manual_section: {
    risk: 'knowledge_read',
    roles: ['knowledge_retriever', 'hypothesis_verifier'],
    input: ManualSectionInputSchema,
    family: 'manual',
  },
  maintenance_search_cases: {
    risk: 'knowledge_read',
    roles: ['knowledge_retriever', 'hypothesis_verifier'],
    input: CaseSearchInputSchema,
    family: 'cases',
  },
  evidence_get: {
    risk: 'read',
    roles: [
      'data_investigator',
      'knowledge_retriever',
      'hypothesis_verifier',
      'report_reviewer',
    ],
    input: EvidenceGetInputSchema,
    family: 'evidence',
  },
};

export interface PolicyContext {
  role: Role;
  tool: string;
  args: unknown;
  run: Run;
  stageRound: number;
  logicalCalls: number;
}

export interface PolicyDecision {
  allowed: boolean;
  code?: ErrorCode;
  message?: string;
  reason: string;
}

export function checkToolPolicy(ctx: PolicyContext): PolicyDecision {
  const tool = ctx.tool as ToolName;
  const policy = TOOL_POLICY[tool];
  if (!policy) {
    return {
      allowed: false,
      code: 'POLICY_DENIED',
      message: `工具 ${ctx.tool} 不在诊断工具白名单内`,
      reason: 'unknown_tool',
    };
  }
  if (!policy.roles.includes(ctx.role)) {
    return {
      allowed: false,
      code: 'POLICY_DENIED',
      message: `角色 ${ctx.role} 无权请求工具 ${tool}`,
      reason: 'role_not_allowed',
    };
  }
  if (policy.risk === 'control' || policy.risk === 'control_intent') {
    return {
      allowed: false,
      code: 'POLICY_DENIED',
      message: '本版不提供任何设备控制工具',
      reason: 'control_tool',
    };
  }
  const parsed = policy.input.safeParse(ctx.args);
  if (!parsed.success) {
    const message = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return {
      allowed: false,
      code: 'INVALID_ARGUMENT',
      message,
      reason: 'schema_invalid',
    };
  }
  const args = parsed.data as Record<string, unknown>;
  if (
    typeof args.equipment_id === 'string' &&
    args.equipment_id !== ctx.run.equipment_id
  ) {
    return {
      allowed: false,
      code: 'FORBIDDEN',
      message: '查询设备超出本次 Run 的作用域',
      reason: 'equipment_scope',
    };
  }
  if (ctx.stageRound > ctx.run.budget.max_rounds_per_stage) {
    return {
      allowed: false,
      code: 'BUDGET_EXCEEDED',
      message: '单阶段编排轮次超限',
      reason: 'stage_round_budget',
    };
  }
  if (ctx.logicalCalls >= ctx.run.budget.max_logical_tool_calls) {
    return {
      allowed: false,
      code: 'BUDGET_EXCEEDED',
      message: '逻辑工具调用数超限',
      reason: 'logical_call_budget',
    };
  }
  if (
    ctx.run.started_at &&
    Date.now() - Date.parse(ctx.run.started_at) >
      ctx.run.budget.run_wall_clock_ms
  ) {
    return {
      allowed: false,
      code: 'BUDGET_EXCEEDED',
      message: 'Run 墙钟时间超限',
      reason: 'wall_clock_budget',
    };
  }
  return { allowed: true, reason: 'allowed' };
}

export function toolFamily(tool: string): string {
  return TOOL_POLICY[tool as ToolName]?.family ?? 'unknown';
}
