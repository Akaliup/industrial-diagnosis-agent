import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  closeContext,
  createSeededContext,
  isoPlus,
  type TestContext,
} from './helpers.js';
import {
  DEFAULT_BUDGET,
  type Evidence,
  type Run,
  type ToolResponseEnvelope,
} from '../../src/diagnosis/contracts/domain.js';
import { DiagnosisEventBus } from '../../src/diagnosis/events.js';
import type { DiagnosisMcpClient } from '../../src/diagnosis/mcp-client.js';
import { RepeatGuard } from '../../src/diagnosis/repeat-guard.js';
import { ToolGateway } from '../../src/diagnosis/tool-gateway.js';
import { canonicalJson, newId, sha256 } from '../../src/diagnosis/util.js';

const START = '2026-11-07T00:00:00.000Z';
const WINDOW = { start: START, end: isoPlus(START, 30) };

let context: TestContext;

beforeAll(async () => {
  context = await createSeededContext('diagnosis-crash');
}, 120_000);

afterAll(() => {
  closeContext(context);
});

function createRun(symptom: string): Run {
  return context.repo.createRun({
    id: newId('run'),
    workspaceId: context.workspaceId,
    userId: 'test-user',
    alarmId: null,
    equipmentId: 'EQ-DEMO-001',
    window: WINDOW,
    symptom,
    dataMode: 'mock',
    modelMode: 'fixture',
    budget: DEFAULT_BUDGET,
    scenarioId: 'demo-sensor-drift',
  });
}

function makeEvidence(run: Run): Evidence {
  const payload = {
    kind: 'work_order' as const,
    work_order_id: 'WO-CRASH-1',
    title: '检查轴承温度',
    status: 'closed',
    opened_at: '2026-11-07T00:05:00.000Z',
    closed_at: '2026-11-07T00:15:00.000Z',
    root_cause_code: null,
    summary: '现场检查',
  };
  return {
    id: `ev_${Math.random().toString(36).slice(2, 12)}`,
    workspace_id: run.workspace_id,
    run_id: run.id,
    source_id: 'src-wo',
    source_kind: 'work_order',
    data_mode: 'mock',
    equipment_id: run.equipment_id,
    observed_at: '2026-11-07T00:10:00.000Z',
    fetched_at: '2026-11-07T00:31:00.000Z',
    source_record_id: 'WO-CRASH-1',
    payload_hash: sha256(canonicalJson(payload)),
    query_hash: sha256('query'),
    locator: { kind: 'db', ref: 'work_orders/WO-CRASH-1' },
    quality_flags: ['good'],
    payload,
  };
}

function makeEnvelope(run: Run, evidence: Evidence[]): ToolResponseEnvelope {
  return {
    schema_version: '1',
    request_id: 'req_crash',
    logical_call_id: 'lc_crash',
    data_mode: 'mock',
    status: 'success',
    data: { ok: true },
    evidence,
    coverage: { ...WINDOW, complete: true, missing: [] },
    warnings: [],
    error: null,
    next_cursor: null,
  };
}

function makeGateway(mcp: Partial<DiagnosisMcpClient>): ToolGateway {
  return new ToolGateway({
    repo: context.repo,
    knowledge: context.knowledge,
    mcp: mcp as DiagnosisMcpClient,
    repeatGuard: new RepeatGuard(),
    bus: new DiagnosisEventBus(),
  });
}

const query = {
  tool: 'equipment_query',
  args: {
    equipment_id: 'EQ-DEMO-001',
    query_kind: 'status',
    window: WINDOW,
  },
};

describe('tool crash consistency', () => {
  test('marks a pre-dispatch journal row unknown on recovery and re-queries safely', async () => {
    const run = createRun('崩溃恢复：请求已发出但回执未落库');
    context.repo.recordToolCall({
      id: 'call_crashed_inflight',
      runId: run.id,
      logicalCallId: 'lc_crashed_inflight',
      attempt: 1,
      tool: 'equipment_query',
      role: 'data_investigator',
      args: query.args,
      argsHash: sha256(canonicalJson(query.args)),
      status: 'inflight',
      errorCode: null,
      durationMs: 0,
      evidenceCount: 0,
      policyDecision: 'allowed',
      startedAt: START,
      finishedAt: null,
    });

    const finished = await context.orchestrator.execute(run.id, {
      owner: 'recovery-worker',
    });
    expect(finished.status).toBe('awaiting_human');

    const calls = context.repo.listToolCalls(run.id);
    const crashed = calls.find((call) => call.id === 'call_crashed_inflight');
    expect(crashed?.status).toBe('unknown');
    expect(crashed?.error_code).toBe('RECEIPT_UNKNOWN');
    expect(crashed?.finished_at).toBeTruthy();
    // 未知回执既不算成功，也不算未执行；后续重新检索另有一条真实成功记录。
    expect(
      calls.some(
        (call) =>
          call.id !== 'call_crashed_inflight' &&
          call.tool === 'equipment_query' &&
          call.status === 'success',
      ),
    ).toBe(true);
    expect(calls.filter((call) => call.status === 'inflight')).toHaveLength(0);

    expect(
      context.repo
        .listEvents(run.id)
        .some(
          (event) =>
            event.type === 'tool.finished' &&
            event.payload.recovered === true &&
            event.payload.status === 'unknown',
        ),
    ).toBe(true);

    const stored = context.repo.getReport(run.id);
    expect(stored?.validation.valid).toBe(true);
  }, 120_000);

  test('journals inflight before dispatch and finishes the same row on receipt', async () => {
    const run = createRun('正常回执：先记 inflight 再落结果');
    const evidence = makeEvidence(run);
    let seenInflight = 0;
    const callWithRetry = vi.fn(
      async (
        _name: string,
        _args: Record<string, unknown>,
        _window: typeof WINDOW,
        options: {
          onAttemptStart?: (attempt: number) => void;
          onAttempt?: (attempt: {
            attempt: number;
            envelope: ToolResponseEnvelope;
            durationMs: number;
          }) => void;
        },
      ) => {
        options.onAttemptStart?.(1);
        seenInflight = context.repo
          .listToolCalls(run.id)
          .filter((call) => call.status === 'inflight').length;
        const envelope = makeEnvelope(run, [evidence]);
        options.onAttempt?.({ attempt: 1, envelope, durationMs: 5 });
        return { envelope, attempts: 1 };
      },
    );

    const outcome = await makeGateway({ callWithRetry }).execute({
      run,
      role: 'data_investigator',
      request: query,
      stageRound: 1,
      logicalCalls: 1,
      sourceAllowlist: null,
      scenarioId: 'demo-sensor-drift',
    });

    expect(seenInflight).toBe(1);
    expect(outcome.ok).toBe(true);
    const rows = context.repo
      .listToolCalls(run.id)
      .filter((call) => call.logical_call_id === outcome.logicalCallId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].finished_at).toBeTruthy();
    expect(rows[0].evidence_count).toBe(1);
    expect(context.repo.listEvidence(run.id)).toHaveLength(1);
  });

  test('marks the attempt unknown when the transport throws after dispatch', async () => {
    const run = createRun('传输层在派发后抛出未包装异常');
    const callWithRetry = vi.fn(
      async (
        _name: string,
        _args: Record<string, unknown>,
        _window: typeof WINDOW,
        options: { onAttemptStart?: (attempt: number) => void },
      ) => {
        options.onAttemptStart?.(1);
        throw new Error('transport crashed');
      },
    );

    await expect(
      makeGateway({ callWithRetry }).execute({
        run,
        role: 'data_investigator',
        request: query,
        stageRound: 1,
        logicalCalls: 1,
        sourceAllowlist: null,
        scenarioId: 'demo-sensor-drift',
      }),
    ).rejects.toThrow('transport crashed');

    const rows = context.repo.listToolCalls(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('unknown');
    expect(rows[0].error_code).toBe('RECEIPT_UNKNOWN');
    expect(rows[0].finished_at).toBeTruthy();
    expect(context.repo.listEvidence(run.id)).toHaveLength(0);
  });

  test('discards a late success after abort and does not cache it', async () => {
    const run = createRun('取消后迟到回执不得入库');
    const evidence = makeEvidence(run);
    const controller = new AbortController();
    let calls = 0;
    const callWithRetry = vi.fn(
      async (
        _name: string,
        _args: Record<string, unknown>,
        _window: typeof WINDOW,
        options: {
          onAttemptStart?: (attempt: number) => void;
          onAttempt?: (attempt: {
            attempt: number;
            envelope: ToolResponseEnvelope;
            durationMs: number;
          }) => void;
        },
      ) => {
        calls += 1;
        options.onAttemptStart?.(1);
        if (calls === 1) controller.abort();
        const envelope = makeEnvelope(run, [evidence]);
        options.onAttempt?.({ attempt: 1, envelope, durationMs: 5 });
        return { envelope, attempts: 1 };
      },
    );
    const gateway = makeGateway({ callWithRetry });

    const cancelled = await gateway.execute({
      run,
      role: 'data_investigator',
      request: query,
      stageRound: 1,
      logicalCalls: 1,
      signal: controller.signal,
      sourceAllowlist: null,
      scenarioId: 'demo-sensor-drift',
    });
    expect(cancelled.ok).toBe(false);
    expect(cancelled.error?.code).toBe('CANCELLED');
    expect(cancelled.newEvidence).toHaveLength(0);
    expect(context.repo.listEvidence(run.id)).toHaveLength(0);
    const cancelledRows = context.repo
      .listToolCalls(run.id)
      .filter((call) => call.logical_call_id === cancelled.logicalCallId);
    expect(cancelledRows).toHaveLength(1);
    expect(cancelledRows[0].status).toBe('cancelled');
    expect(cancelledRows[0].error_code).toBe('CANCELLED');
    expect(cancelledRows[0].evidence_count).toBe(0);

    // 取消结果没有进入重复调用缓存；下一次正常调用仍会真正执行并入库。
    const retried = await gateway.execute({
      run,
      role: 'data_investigator',
      request: query,
      stageRound: 1,
      logicalCalls: 2,
      sourceAllowlist: null,
      scenarioId: 'demo-sensor-drift',
    });
    expect(retried.ok).toBe(true);
    expect(callWithRetry).toHaveBeenCalledTimes(2);
    expect(context.repo.listEvidence(run.id)).toHaveLength(1);
  });

  test('discards a late success when the run was cancelled without abort', async () => {
    const run = createRun('数据库取消后迟到回执不得入库');
    const evidence = makeEvidence(run);
    const callWithRetry = vi.fn(
      async (
        _name: string,
        _args: Record<string, unknown>,
        _window: typeof WINDOW,
        options: {
          onAttemptStart?: (attempt: number) => void;
          onAttempt?: (attempt: {
            attempt: number;
            envelope: ToolResponseEnvelope;
            durationMs: number;
          }) => void;
        },
      ) => {
        options.onAttemptStart?.(1);
        context.repo.updateRun(run.id, { status: 'cancelled' });
        const envelope = makeEnvelope(run, [evidence]);
        options.onAttempt?.({ attempt: 1, envelope, durationMs: 5 });
        return { envelope, attempts: 1 };
      },
    );

    const outcome = await makeGateway({ callWithRetry }).execute({
      run,
      role: 'data_investigator',
      request: query,
      stageRound: 1,
      logicalCalls: 1,
      sourceAllowlist: null,
      scenarioId: 'demo-sensor-drift',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('CANCELLED');
    expect(context.repo.listEvidence(run.id)).toHaveLength(0);
    const rows = context.repo
      .listToolCalls(run.id)
      .filter((call) => call.logical_call_id === outcome.logicalCallId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].evidence_count).toBe(0);
  });
});
