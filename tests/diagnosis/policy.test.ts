import { describe, expect, test } from 'vitest';
import {
  DEFAULT_BUDGET,
  type Run,
} from '../../src/diagnosis/contracts/domain.js';
import { checkToolPolicy, TOOL_POLICY } from '../../src/diagnosis/policy.js';

const WINDOW = {
  start: '2026-11-07T00:00:00.000Z',
  end: '2026-11-07T00:30:00.000Z',
};

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_policy',
    workspace_id: 'ws_policy',
    user_id: 'user_policy',
    status: 'running',
    stage: 'confirm_status',
    alarm_id: null,
    equipment_id: 'EQ-DEMO-001',
    window: WINDOW,
    symptom: 'test',
    data_mode: 'mock',
    model_mode: 'fixture',
    budget: DEFAULT_BUDGET,
    stage_rounds: {},
    total_rounds: 0,
    logical_calls: 0,
    model_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    no_new_evidence_rounds: 0,
    checkpoint: null,
    error: null,
    handoff_reason: null,
    review_status: 'pending',
    conclusion_status: 'hypothesis',
    created_at: '2026-11-07T00:31:00.000Z',
    started_at: new Date().toISOString(),
    finished_at: null,
    lease_owner: null,
    lease_expires_at: null,
    ...overrides,
  };
}

function decide(
  input: {
    role?: Parameters<typeof checkToolPolicy>[0]['role'];
    tool?: string;
    args?: unknown;
    stageRound?: number;
    logicalCalls?: number;
  } = {},
) {
  return checkToolPolicy({
    role: input.role ?? 'data_investigator',
    tool: input.tool ?? 'equipment_query',
    args: input.args ?? {
      equipment_id: 'EQ-DEMO-001',
      query_kind: 'status',
      window: WINDOW,
    },
    run: makeRun(),
    stageRound: input.stageRound ?? 1,
    logicalCalls: input.logicalCalls ?? 0,
  });
}

describe('diagnosis policy gateway', () => {
  test('allows a whitelisted read tool for the owning role', () => {
    const decision = decide();
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
  });

  test('denies unknown tools such as shell and device control', () => {
    for (const tool of ['shell', 'device_control', 'write_file', 'mcp_any']) {
      const decision = decide({ tool });
      expect(decision.allowed, tool).toBe(false);
      expect(decision.code).toBe('POLICY_DENIED');
      expect(decision.reason).toBe('unknown_tool');
    }
  });

  test('denies tools outside the role allowlist', () => {
    const decision = decide({
      role: 'knowledge_retriever',
      tool: 'equipment_query',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('role_not_allowed');
    expect(decision.code).toBe('POLICY_DENIED');
  });

  test('denies control risk even if a policy entry is injected', () => {
    const policy = TOOL_POLICY as Record<string, unknown>;
    policy.device_control = {
      risk: 'control',
      roles: ['data_investigator'],
      input: TOOL_POLICY.equipment_query.input,
      family: 'control',
    };
    try {
      const decision = decide({ tool: 'device_control' });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('control_tool');
      expect(decision.code).toBe('POLICY_DENIED');
    } finally {
      delete policy.device_control;
    }
  });

  test('rejects unknown arguments and out-of-scope equipment', () => {
    const extra = decide({
      args: {
        equipment_id: 'EQ-DEMO-001',
        query_kind: 'status',
        window: WINDOW,
        control: 'start',
      },
    });
    expect(extra.allowed).toBe(false);
    expect(extra.reason).toBe('schema_invalid');
    expect(extra.code).toBe('INVALID_ARGUMENT');

    const otherEquipment = decide({
      args: {
        equipment_id: 'EQ-DEMO-002',
        query_kind: 'status',
        window: WINDOW,
      },
    });
    expect(otherEquipment.allowed).toBe(false);
    expect(otherEquipment.reason).toBe('equipment_scope');
    expect(otherEquipment.code).toBe('FORBIDDEN');
  });

  test('enforces stage, logical-call and wall-clock budgets', () => {
    expect(decide({ stageRound: 4 }).reason).toBe('stage_round_budget');
    expect(decide({ logicalCalls: 32 }).reason).toBe('logical_call_budget');
    const stale = checkToolPolicy({
      role: 'data_investigator',
      tool: 'equipment_query',
      args: {
        equipment_id: 'EQ-DEMO-001',
        query_kind: 'status',
        window: WINDOW,
      },
      run: makeRun({
        started_at: new Date(Date.now() - 301_000).toISOString(),
      }),
      stageRound: 1,
      logicalCalls: 0,
    });
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toBe('wall_clock_budget');
    expect(stale.code).toBe('BUDGET_EXCEEDED');
  });
});
