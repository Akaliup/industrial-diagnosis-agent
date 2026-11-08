import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  closeContext,
  createSeededContext,
  FIXTURES,
  isoPlus,
  type TestContext,
} from './helpers.js';
import { DiagnosisEventBus } from '../../src/diagnosis/events.js';
import {
  BudgetExceededError,
  DiagnosisOrchestrator,
} from '../../src/diagnosis/orchestrator.js';
import {
  RoleRunnerError,
  type RoleRunner,
} from '../../src/diagnosis/role-runner.js';
import {
  DEFAULT_BUDGET,
  type Role,
  type Run,
  type Stage,
} from '../../src/diagnosis/contracts/domain.js';
import { newId } from '../../src/diagnosis/util.js';

let context: TestContext;

beforeAll(async () => {
  context = await createSeededContext('diagnosis-budget');
}, 120_000);

afterAll(() => {
  closeContext(context);
});

function makeRun(budget = DEFAULT_BUDGET): Run {
  const start = '2026-11-07T00:00:00.000Z';
  return context.repo.createRun({
    id: newId('run'),
    workspaceId: context.workspaceId,
    userId: 'budget-test',
    alarmId: null,
    equipmentId: 'EQ-DEMO-001',
    window: { start, end: isoPlus(start, 30) },
    symptom: null,
    dataMode: 'mock',
    modelMode: 'fixture',
    budget,
    scenarioId: null,
  });
}

function makeState(run: Run) {
  return {
    run: { ...run, status: 'running' as const },
    leaseToken: run.lease_token,
    stage: 'confirm_status' as const,
    stageRounds: {},
    totalRounds: 0,
    logicalCalls: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    noNewEvidenceRounds: 0,
    checkpoint: {},
    newEvidenceIds: [],
  };
}

function orchestratorWith(runner: RoleRunner): DiagnosisOrchestrator {
  return new DiagnosisOrchestrator({
    repo: context.repo,
    knowledge: context.knowledge,
    bus: new DiagnosisEventBus(),
    runner,
    fixturesDir: FIXTURES,
  });
}

function callRole(
  orchestrator: DiagnosisOrchestrator,
  state: ReturnType<typeof makeState>,
  stage: Stage = 'confirm_status',
  role: Role = 'data_investigator',
): Promise<unknown> {
  return (
    orchestrator as unknown as {
      callRole: (
        state: unknown,
        role: string,
        stage: string,
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).callRole(state, role, stage);
}

describe('run budget accounting', () => {
  test('caps each request and reserves output budget for the report stage', async () => {
    const seen: number[] = [];
    const runner: RoleRunner = {
      mode: 'fixture',
      model: 'fake-compliant',
      run: async (input) => {
        const limit = input.limits?.maxOutputTokens ?? 0;
        seen.push(limit);
        return {
          output: {},
          mode: 'fixture',
          model: 'fake-compliant',
          inputTokens: 1,
          outputTokens: Math.min(5000, limit),
          latencyMs: 0,
        };
      },
    };
    const orchestrator = orchestratorWith(runner);
    const state = makeState(
      makeRun({
        ...DEFAULT_BUDGET,
        max_output_tokens: 14_100,
        max_rounds_total: 20,
        max_rounds_per_stage: 20,
      }),
    );
    for (const stage of [
      'confirm_status',
      'locate_anomaly',
      'generate_hypotheses',
    ] as const) {
      for (
        let index = 0;
        index < (stage === 'generate_hypotheses' ? 2 : 3);
        index += 1
      ) {
        await callRole(orchestrator, state, stage);
      }
    }
    // 调查阶段单次最多 1200；8 次调查后剩 4500，报告阶段可用 4500。
    expect(seen).toEqual([1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200]);
    expect(state.outputTokens).toBe(9600);
    await callRole(orchestrator, state, 'produce_report', 'report_reviewer');
    expect(seen.at(-1)).toBe(4500);
    expect(state.outputTokens).toBe(14_100);
    await expect(
      callRole(orchestrator, state, 'produce_report', 'report_reviewer'),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    // 预算耗尽后的请求在发出前就被拦截。
    expect(seen).toHaveLength(9);
  });

  test('does not start an optional second look without report output reserve', () => {
    const runner: RoleRunner = {
      mode: 'fixture',
      model: 'fake-unused',
      run: async () => ({
        output: {},
        mode: 'fixture',
        model: 'fake-unused',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 0,
      }),
    };
    const orchestrator = orchestratorWith(runner);
    const state = makeState(
      makeRun({
        ...DEFAULT_BUDGET,
        max_output_tokens: 12_000,
      }),
    );
    state.stageRounds.verify_evidence = 1;
    state.totalRounds = 1;
    state.modelCalls = 5;
    const canRunSecondLook = (
      orchestrator as unknown as {
        canRunSecondLook: (value: unknown) => boolean;
      }
    ).canRunSecondLook.bind(orchestrator);
    state.outputTokens = 8_000; // 剩余 4,000，低于 4,500 + 400 预留
    expect(canRunSecondLook(state)).toBe(false);
    state.outputTokens = 0;
    expect(canRunSecondLook(state)).toBe(true);
  });

  test('reserves the report round before starting an optional second look', () => {
    const runner: RoleRunner = {
      mode: 'fixture',
      model: 'fake-unused',
      run: async () => ({
        output: {},
        mode: 'fixture',
        model: 'fake-unused',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 0,
      }),
    };
    const orchestrator = orchestratorWith(runner);
    const state = makeState(
      makeRun({
        ...DEFAULT_BUDGET,
        max_rounds_total: 6,
        max_rounds_per_stage: 3,
      }),
    );
    state.stageRounds.verify_evidence = 1;
    state.totalRounds = 5;
    state.modelCalls = 5;
    const canRunSecondLook = (
      orchestrator as unknown as {
        canRunSecondLook: (value: unknown) => boolean;
      }
    ).canRunSecondLook.bind(orchestrator);
    // 只剩 1 轮，必须留给 produce_report；二次复核不得启动。
    expect(canRunSecondLook(state)).toBe(false);
    state.run.budget.max_rounds_total = 8;
    // 8 轮预算下仍有 3 轮：二次复核 + 可能的跟进复核 + 报告。
    expect(canRunSecondLook(state)).toBe(true);
  });

  test('reserves stage rounds for a second look and its follow-up', () => {
    const runner: RoleRunner = {
      mode: 'fixture',
      model: 'fake-unused',
      run: async () => ({
        output: {},
        mode: 'fixture',
        model: 'fake-unused',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 0,
      }),
    };
    const orchestrator = orchestratorWith(runner);
    const state = makeState(
      makeRun({
        ...DEFAULT_BUDGET,
        max_rounds_total: 8,
        max_rounds_per_stage: 3,
      }),
    );
    state.stageRounds.verify_evidence = 1;
    state.totalRounds = 5;
    state.modelCalls = 5;
    const canRunSecondLook = (
      orchestrator as unknown as {
        canRunSecondLook: (value: unknown) => boolean;
      }
    ).canRunSecondLook.bind(orchestrator);
    expect(canRunSecondLook(state)).toBe(true);
    // 只剩 1 个阶段轮次时，二次复核会吃掉跟进复核的空间。
    state.stageRounds.verify_evidence = 2;
    expect(canRunSecondLook(state)).toBe(false);
  });

  test('reserves a model call for the report before an optional follow-up', () => {
    const runner: RoleRunner = {
      mode: 'fixture',
      model: 'fake-unused',
      run: async () => ({
        output: {},
        mode: 'fixture',
        model: 'fake-unused',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 0,
      }),
    };
    const orchestrator = orchestratorWith(runner);
    const state = makeState(makeRun());
    state.stageRounds.verify_evidence = 2;
    state.totalRounds = 6;
    const canRunVerifyFollowUp = (
      orchestrator as unknown as {
        canRunVerifyFollowUp: (value: unknown) => boolean;
      }
    ).canRunVerifyFollowUp.bind(orchestrator);
    // 16 次调用上限下只剩 2 次：跟进复核可能用掉 2 次，报告将无调用可用。
    state.modelCalls = DEFAULT_BUDGET.max_model_calls - 2;
    expect(canRunVerifyFollowUp(state)).toBe(false);
    // 留出 3 次时，跟进复核（含 1 次修复）后仍能给报告留 1 次。
    state.modelCalls = DEFAULT_BUDGET.max_model_calls - 3;
    expect(canRunVerifyFollowUp(state)).toBe(true);
  });

  test('keeps the final total round for the report stage', async () => {
    let calls = 0;
    const runner: RoleRunner = {
      mode: 'fixture',
      model: 'fake-rounds',
      run: async () => {
        calls += 1;
        return {
          output: {},
          mode: 'fixture',
          model: 'fake-rounds',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 0,
        };
      },
    };
    const orchestrator = orchestratorWith(runner);
    const state = makeState(
      makeRun({
        ...DEFAULT_BUDGET,
        max_rounds_total: 6,
        max_rounds_per_stage: 6,
        max_output_tokens: 20_000,
      }),
    );
    state.totalRounds = 5;
    state.stage = 'verify_evidence';
    await expect(
      callRole(orchestrator, state, 'verify_evidence', 'hypothesis_verifier'),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toBe(0);
    // 同一预算下，报告阶段仍可使用最后一轮。
    state.stage = 'produce_report';
    await callRole(orchestrator, state, 'produce_report', 'report_reviewer');
    expect(calls).toBe(1);
    expect(state.totalRounds).toBe(6);
  });

  test('records actual usage and rejects a model that ignores max_tokens', async () => {
    let calls = 0;
    const runner: RoleRunner = {
      mode: 'fixture',
      model: 'fake-overflow',
      run: async () => {
        calls += 1;
        return {
          output: {},
          mode: 'fixture',
          model: 'fake-overflow',
          inputTokens: 1,
          outputTokens: 7000,
          latencyMs: 0,
        };
      },
    };
    const orchestrator = orchestratorWith(runner);
    const state = makeState(makeRun());
    await callRole(orchestrator, state);
    await expect(callRole(orchestrator, state)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(calls).toBe(2);
    // 超限结果不被接受，但实际消耗必须如实记录，不能当作 0。
    expect(state.outputTokens).toBe(14_000);
  });

  test('counts the repair attempt against max_model_calls', async () => {
    let calls = 0;
    const runner: RoleRunner = {
      mode: 'fixture',
      model: 'fake-invalid',
      run: async () => {
        calls += 1;
        throw new RoleRunnerError('invalid json', 'INVALID_OUTPUT');
      },
    };
    const orchestrator = orchestratorWith(runner);
    const state = makeState(makeRun());
    state.modelCalls = DEFAULT_BUDGET.max_model_calls - 1;
    await expect(callRole(orchestrator, state)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(state.modelCalls).toBe(DEFAULT_BUDGET.max_model_calls);
    // 第 16 次之后不再发出第 17 次修复请求。
    expect(calls).toBe(1);
  });

  test('counts transport retries reported by the runner', async () => {
    let calls = 0;
    const runner: RoleRunner = {
      mode: 'fixture',
      model: 'fake-retry',
      run: async () => {
        calls += 1;
        return {
          output: {},
          mode: 'fixture',
          model: 'fake-retry',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 0,
          attempts: 2,
        };
      },
    };
    const orchestrator = orchestratorWith(runner);
    const state = makeState(makeRun());
    await callRole(orchestrator, state);
    expect(calls).toBe(1);
    expect(state.modelCalls).toBe(2);
  });
});
