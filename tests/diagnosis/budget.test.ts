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
  type Run,
} from '../../src/diagnosis/contracts/domain.js';
import { newId } from '../../src/diagnosis/util.js';

let context: TestContext;

beforeAll(async () => {
  context = await createSeededContext('diagnosis-budget');
}, 120_000);

afterAll(() => {
  closeContext(context);
});

function makeRun(): Run {
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
    budget: DEFAULT_BUDGET,
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
  ).callRole(state, 'data_investigator', 'confirm_status');
}

describe('run budget accounting', () => {
  test('limits each request to the remaining output budget and stops at the cap', async () => {
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
    const state = makeState(makeRun());
    await callRole(orchestrator, state);
    await callRole(orchestrator, state);
    expect(seen).toEqual([8000, 3000]);
    expect(state.outputTokens).toBe(8000);
    await expect(callRole(orchestrator, state)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    // 第三次请求在发出前就被预算拦截。
    expect(seen).toHaveLength(2);
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
          outputTokens: 5000,
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
    expect(state.outputTokens).toBe(10_000);
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
