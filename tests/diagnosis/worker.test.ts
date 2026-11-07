import { afterEach, describe, expect, test } from 'vitest';
import {
  closeContext,
  createSeededContext,
  isoPlus,
  type TestContext,
} from './helpers.js';
import { DiagnosisWorker } from '../../src/diagnosis/worker.js';
import { DiagnosisOrchestrator } from '../../src/diagnosis/orchestrator.js';
import { DiagnosisEventBus } from '../../src/diagnosis/events.js';
import { FixtureRoleRunner } from '../../src/diagnosis/fixture-role-runner.js';
import type { RoleRunner } from '../../src/diagnosis/role-runner.js';
import { DEFAULT_BUDGET } from '../../src/diagnosis/contracts/domain.js';
import { newId } from '../../src/diagnosis/util.js';
import { FIXTURES } from './helpers.js';

const contexts: TestContext[] = [];

afterEach(() => {
  while (contexts.length > 0) {
    closeContext(contexts.pop()!);
  }
});

async function createRun(context: TestContext) {
  const alarm = context.repo
    .listAlarms(context.workspaceId)
    .find((item) => item.source_alarm_id === 'ALM-demo-sensor-drift');
  if (!alarm) throw new Error('sensor-drift alarm missing');
  const start = '2026-11-07T00:00:00.000Z';
  const run = context.repo.createRun({
    id: newId('run'),
    workspaceId: context.workspaceId,
    userId: 'test-user',
    alarmId: alarm.id,
    equipmentId: 'EQ-DEMO-001',
    window: { start, end: isoPlus(start, 30) },
    symptom: '1号循环泵轴承温度持续上升，振动与电流稳定',
    dataMode: 'mock',
    modelMode: 'fixture',
    budget: DEFAULT_BUDGET,
    scenarioId: 'demo-sensor-drift',
  });
  context.repo.appendEvent(run.id, 'run.created', {
    workspace_id: context.workspaceId,
    scenario_id: 'demo-sensor-drift',
  });
  return run;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timeout');
}

describe('DiagnosisWorker leases', () => {
  test('recovers an expired running lease and finishes the run', async () => {
    const context = await createSeededContext('diagnosis-worker-recover');
    contexts.push(context);
    const run = await createRun(context);
    context.repo.updateRun(run.id, {
      status: 'running',
      lease_owner: 'crashed-worker',
      lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
      started_at: new Date(Date.now() - 120_000).toISOString(),
    });

    const worker = new DiagnosisWorker({
      repo: context.repo,
      orchestrator: context.orchestrator,
      concurrency: 1,
      pollIntervalMs: 50,
      leaseMs: 5_000,
    });
    worker.start();
    await waitFor(
      () => context.repo.getRun(run.id)?.status === 'awaiting_human',
    );
    await worker.stop();

    const finished = context.repo.getRun(run.id);
    expect(finished?.status).toBe('awaiting_human');
    const events = context.repo.listEvents(run.id, 0, 500);
    expect(events.some((event) => event.type === 'run.started')).toBe(true);
  }, 30_000);

  test('does not steal a live lease held by another worker', async () => {
    const context = await createSeededContext('diagnosis-worker-live-lease');
    contexts.push(context);
    const run = await createRun(context);
    context.repo.updateRun(run.id, {
      status: 'running',
      lease_owner: 'other-worker',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      started_at: new Date().toISOString(),
    });

    const worker = new DiagnosisWorker({
      repo: context.repo,
      orchestrator: context.orchestrator,
      concurrency: 1,
      pollIntervalMs: 50,
      leaseMs: 5_000,
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.stop();

    expect(context.repo.getRun(run.id)?.status).toBe('running');
    expect(
      context.repo
        .listEvents(run.id, 0, 500)
        .some((event) => event.type === 'run.started'),
    ).toBe(false);
  }, 30_000);

  test('a worker that loses its lease during a long model call cannot write results', async () => {
    const context = await createSeededContext('diagnosis-worker-fence');
    contexts.push(context);
    const run = await createRun(context);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = new FixtureRoleRunner();
    const slowRunner: RoleRunner = {
      mode: 'fixture',
      model: 'slow-fixture',
      run: async (input) => {
        await gate;
        return fixture.run(input);
      },
    };
    const orchestratorA = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner: slowRunner,
      fixturesDir: FIXTURES,
    });
    const workerA = new DiagnosisWorker({
      repo: context.repo,
      orchestrator: orchestratorA,
      concurrency: 1,
      pollIntervalMs: 50,
      leaseMs: 5_000,
    });
    workerA.start();
    await waitFor(
      () => context.repo.getRun(run.id)?.lease_owner === workerA.ownerId,
    );

    // 模型调用期间租约到期，另一个 Worker 接管并完成 Run。
    context.repo.updateRun(run.id, {
      lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const tokenB = context.repo.claimRun(run.id, 'worker-b', 5_000);
    expect(tokenB).not.toBeNull();
    const finishedByB = await context.orchestrator.execute(run.id, {
      owner: 'worker-b',
      leaseToken: tokenB!,
    });
    expect(finishedByB.status).toBe('awaiting_human');
    const reportByB = JSON.stringify(context.repo.getReport(run.id)!.report);

    release();
    await waitFor(() => workerA.activeCount === 0, 15_000);
    await workerA.stop();

    // 迟到的 Worker A 不得覆盖 B 的报告或把 Run 改回 running。
    expect(context.repo.getRun(run.id)?.status).toBe('awaiting_human');
    expect(JSON.stringify(context.repo.getReport(run.id)!.report)).toBe(
      reportByB,
    );
    expect(
      context.repo
        .listEvents(run.id, 0, 500)
        .filter((event) => event.type === 'run.started'),
    ).toHaveLength(1);
  }, 30_000);

  test('two workers claim a queued run at most once', async () => {
    const context = await createSeededContext('diagnosis-worker-claim');
    contexts.push(context);
    const run = await createRun(context);
    const first = new DiagnosisWorker({
      repo: context.repo,
      orchestrator: context.orchestrator,
      concurrency: 1,
      pollIntervalMs: 50,
      leaseMs: 5_000,
    });
    const second = new DiagnosisWorker({
      repo: context.repo,
      orchestrator: context.orchestrator,
      concurrency: 1,
      pollIntervalMs: 50,
      leaseMs: 5_000,
    });
    first.start();
    second.start();
    await waitFor(
      () => context.repo.getRun(run.id)?.status === 'awaiting_human',
    );
    await Promise.all([first.stop(), second.stop()]);

    const started = context.repo
      .listEvents(run.id, 0, 500)
      .filter((event) => event.type === 'run.started');
    expect(started).toHaveLength(1);
  }, 30_000);
});
