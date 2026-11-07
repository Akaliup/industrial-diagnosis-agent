import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  closeContext,
  createSeededContext,
  DEMO_SCENARIOS,
  FIXTURES,
  isoPlus,
  runDemo,
  type TestContext,
} from './helpers.js';
import { DiagnosisEventBus } from '../../src/diagnosis/events.js';
import { FixtureRoleRunner } from '../../src/diagnosis/fixture-role-runner.js';
import { DiagnosisOrchestrator } from '../../src/diagnosis/orchestrator.js';
import {
  RoleRunnerError,
  type RoleCallInput,
  type RoleCallResult,
  type RoleRunner,
} from '../../src/diagnosis/role-runner.js';
import { newId } from '../../src/diagnosis/util.js';
import { DEFAULT_BUDGET } from '../../src/diagnosis/contracts/domain.js';

let context: TestContext;

beforeAll(async () => {
  context = await createSeededContext('diagnosis-orchestrator');
}, 120_000);

afterAll(() => {
  closeContext(context);
});

class WithdrawCitedManualOnReportRunner implements RoleRunner {
  private handled = false;
  private citedDocumentId: string | null = null;

  constructor(
    private readonly inner: FixtureRoleRunner,
    private readonly repo: TestContext['repo'],
  ) {}

  get mode() {
    return this.inner.mode;
  }

  get model() {
    return this.inner.model;
  }

  get documentId(): string | null {
    return this.citedDocumentId;
  }

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    if (input.role === 'report_reviewer' && !this.handled) {
      this.handled = true;
      const manual = input.evidence.find(
        (item) => item.payload.kind === 'manual_chunk',
      );
      if (manual?.payload.kind === 'manual_chunk') {
        this.citedDocumentId = manual.payload.document_id;
        this.repo.setDocumentWithdrawn(
          input.run.workspace_id,
          manual.payload.document_id,
          true,
        );
      }
    }
    return this.inner.run(input);
  }
}

class ModelHandoffReasonRunner implements RoleRunner {
  constructor(private readonly inner: FixtureRoleRunner) {}

  get mode() {
    return this.inner.mode;
  }

  get model() {
    return this.inner.model;
  }

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    const result = await this.inner.run(input);
    if (input.role === 'report_reviewer') {
      const output = result.output as {
        report?: { handoff_reason?: string | null };
      };
      if (output.report) {
        output.report.handoff_reason = '模型建议人工复核';
      }
    }
    return result;
  }
}

class ReportStatusDriftRunner implements RoleRunner {
  constructor(private readonly inner: FixtureRoleRunner) {}

  get mode() {
    return this.inner.mode;
  }

  get model() {
    return this.inner.model;
  }

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    const result = await this.inner.run(input);
    if (input.role === 'report_reviewer') {
      const output = result.output as {
        report?: {
          hypotheses?: Array<{ status: string }>;
        };
      };
      const target = output.report?.hypotheses?.find(
        (hypothesis) => hypothesis.status === 'supported',
      );
      if (target) target.status = 'inconclusive';
    }
    return result;
  }
}

class BudgetExhaustedVerifyRunner implements RoleRunner {
  constructor(private readonly inner: FixtureRoleRunner) {}

  get mode() {
    return this.inner.mode;
  }

  get model() {
    return this.inner.model;
  }

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    if (
      input.role === 'hypothesis_verifier' &&
      input.stage === 'verify_evidence'
    ) {
      const error = new RoleRunnerError(
        '角色 hypothesis_verifier 输出不是合法 JSON：模拟截断',
        'INVALID_OUTPUT',
      );
      // 第一次无效输出已消耗大量额度；修复调用只剩报告预留，
      // 会触发 BudgetExceededError。已有 supported 根因时仍应生成报告。
      error.usage = { inputTokens: 1_200, outputTokens: 7_000 };
      error.rawOutput = '{"summary":"候选根因","hypotheses":[';
      throw error;
    }
    return this.inner.run(input);
  }
}

describe('diagnosis orchestrator', () => {
  test('runs all five demo scenarios with valid cited reports', async () => {
    for (const demo of DEMO_SCENARIOS) {
      const run = await runDemo(context, demo);
      expect(run.status, demo.id).toBe('awaiting_human');
      expect(run.error, demo.id).toBeNull();
      expect(run.total_rounds, demo.id).toBeLessThanOrEqual(
        DEFAULT_BUDGET.max_rounds_total,
      );
      expect(run.logical_calls, demo.id).toBeLessThanOrEqual(
        DEFAULT_BUDGET.max_logical_tool_calls,
      );
      expect(run.model_calls, demo.id).toBeLessThanOrEqual(
        DEFAULT_BUDGET.max_model_calls,
      );
      for (const [stage, rounds] of Object.entries(run.stage_rounds)) {
        expect(rounds, `${demo.id}/${stage}`).toBeLessThanOrEqual(
          DEFAULT_BUDGET.max_rounds_per_stage,
        );
      }
      if (demo.handoff) {
        expect(run.handoff_reason, demo.id).toBeTruthy();
        expect(run.conclusion_status, demo.id).toBe('insufficient_evidence');
      } else {
        expect(run.stage, demo.id).toBe('produce_report');
      }

      const stored = context.repo.getReport(run.id);
      expect(stored, demo.id).not.toBeNull();
      expect(stored!.validation.valid, demo.id).toBe(true);
      const supported = stored!.report.hypotheses
        .filter((hypothesis) => hypothesis.status === 'supported')
        .map((hypothesis) => hypothesis.code)
        .sort();
      expect(supported, demo.id).toEqual([...demo.expected].sort());
      expect(stored!.report.limitations.join(' ')).toMatch(/Mock|模拟/);
      expect(stored!.report.limitations.join(' ')).toMatch(
        /Fixture|预录|规则推理/,
      );

      const evidence = context.repo.listEvidence(run.id);
      expect(evidence.length, demo.id).toBeGreaterThan(0);
      for (const item of evidence) {
        expect(item.run_id, demo.id).toBe(run.id);
        expect(item.workspace_id, demo.id).toBe(context.workspaceId);
        expect(item.equipment_id ?? demo.device, demo.id).toBe(demo.device);
      }
      const evidenceIds = new Set(evidence.map((item) => item.id));
      for (const hypothesis of stored!.report.hypotheses) {
        for (const id of [
          ...hypothesis.supporting_evidence_ids,
          ...hypothesis.contradicting_evidence_ids,
        ]) {
          expect(evidenceIds.has(id), `${demo.id}:${id}`).toBe(true);
        }
      }

      const calls = context.repo.listToolCalls(run.id);
      expect(calls.length, demo.id).toBeGreaterThan(0);
      for (const call of calls) {
        expect(
          ['allowed', 'cached', 'repeated'],
          `${demo.id}:${call.tool}:${call.policy_decision}`,
        ).toContain(call.policy_decision);
        expect(call.error_code, `${demo.id}:${call.tool}`).not.toBe(
          'CONTROL_EXECUTION_DISABLED',
        );
      }

      const events = context.repo.listEvents(run.id);
      const types = events.map((event) => event.type);
      expect(types, demo.id).toContain('run.created');
      expect(types, demo.id).toContain('report.ready');
      expect(types, demo.id).toContain('review.required');
      const stages = events
        .filter((event) => event.type === 'stage.changed')
        .map((event) => event.payload.to);
      expect(new Set(stages).size, demo.id).toBeGreaterThanOrEqual(2);
    }
  }, 120_000);

  test('records every model call with role, model, tokens, latency and tool requests', async () => {
    const run = await runDemo(context, DEMO_SCENARIOS[0]);
    const calls = context.repo.listModelCalls(run.id);
    expect(calls.length).toBe(run.model_calls);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(String(call.role)).not.toBe('');
      expect(String(call.stage)).not.toBe('');
      expect(String(call.model)).toContain('fixture');
      expect(String(call.mode)).toBe('fixture');
      expect(String(call.status)).toBe('success');
      expect(Number(call.input_tokens)).toBeGreaterThan(0);
      expect(Number(call.output_tokens)).toBeGreaterThan(0);
      expect(Number(call.latency_ms)).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(JSON.parse(String(call.tool_requests_json)))).toBe(
        true,
      );
      expect(String(call.raw_output)).not.toBe('');
    }
    const withRequests = calls.filter(
      (call) => JSON.parse(String(call.tool_requests_json)).length > 0,
    );
    expect(withRequests.length).toBeGreaterThan(0);
    expect(context.repo.countModelCallFailures(run.id)).toBe(0);
  }, 120_000);

  test('replaying the same scenario keeps the reasoning outcome stable', async () => {
    const demo = DEMO_SCENARIOS[0];
    const first = await runDemo(context, demo);
    const second = await runDemo(context, demo);
    const summarize = (runId: string) => {
      const stored = context.repo.getReport(runId)!;
      return {
        codes: stored.report.hypotheses
          .map((item) => `${item.code}:${item.status}`)
          .sort(),
        observations: stored.report.observations.length,
        checks: stored.report.checks.length,
        recommendations: stored.report.recommendations.length,
        evidenceKinds: context.repo
          .listEvidence(runId)
          .map((item) => item.payload.kind)
          .sort(),
      };
    };
    expect(summarize(second.id)).toEqual(summarize(first.id));
  }, 120_000);

  test('withdrawn manual documents are excluded from new retrieval', async () => {
    context.repo.setDocumentWithdrawn(
      context.workspaceId,
      'DOC-NP200-V2',
      true,
    );
    try {
      const run = await runDemo(context, DEMO_SCENARIOS[0]);
      const stored = context.repo.getReport(run.id)!;
      expect(stored.validation.valid).toBe(true);
      const cited = context.repo
        .listEvidence(run.id)
        .filter((item) => item.payload.kind === 'manual_chunk')
        .map((item) =>
          item.payload.kind === 'manual_chunk' ? item.payload.document_id : '',
        );
      expect(cited).not.toContain('DOC-NP200-V2');
      expect(cited).toContain('DOC-NP200-V2-ZH');
    } finally {
      context.repo.setDocumentWithdrawn(
        context.workspaceId,
        'DOC-NP200-V2',
        false,
      );
    }
  }, 60_000);

  test('a manual withdrawn before report repair cannot pass the repaired validation', async () => {
    const runner = new WithdrawCitedManualOnReportRunner(
      new FixtureRoleRunner(),
      context.repo,
    );
    const orchestrator = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner,
      fixturesDir: FIXTURES,
    });
    const demo = DEMO_SCENARIOS[0];
    const alarm = context.repo
      .listAlarms(context.workspaceId)
      .find((item) => item.source_alarm_id === `ALM-${demo.id}`);
    if (!alarm) throw new Error('fixture alarm missing');
    const run = context.repo.createRun({
      id: newId('run'),
      workspaceId: context.workspaceId,
      userId: 'test-user',
      alarmId: alarm.id,
      equipmentId: demo.device,
      window: {
        start: demo.start,
        end: isoPlus(demo.start, 30),
      },
      symptom: demo.symptom,
      dataMode: 'mock',
      modelMode: 'fixture',
      budget: DEFAULT_BUDGET,
      scenarioId: demo.id,
    });
    context.repo.appendEvent(run.id, 'run.created', {
      workspace_id: context.workspaceId,
      equipment_id: run.equipment_id,
      alarm_id: run.alarm_id,
      data_mode: run.data_mode,
      model_mode: run.model_mode,
      scenario_id: demo.id,
    });

    try {
      const finished = await orchestrator.execute(run.id, {
        owner: 'test-worker',
      });
      const stored = context.repo.getReport(run.id)!;
      expect(runner.documentId).toBeTruthy();
      expect(stored.validation.valid).toBe(false);
      expect(stored.validation.issues.map((item) => item.code)).toContain(
        'MANUAL_DOCUMENT_WITHDRAWN',
      );
      expect(finished.conclusion_status).toBe('insufficient_evidence');
      expect(finished.handoff_reason).toBeTruthy();
    } finally {
      if (runner.documentId) {
        context.repo.setDocumentWithdrawn(
          context.workspaceId,
          runner.documentId,
          false,
        );
      }
    }
  }, 120_000);

  test('a supported diagnosis does not inherit the model handoff reason', async () => {
    const orchestrator = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner: new ModelHandoffReasonRunner(new FixtureRoleRunner()),
      fixturesDir: FIXTURES,
    });
    const demo = DEMO_SCENARIOS[0];
    const alarm = context.repo
      .listAlarms(context.workspaceId)
      .find((item) => item.source_alarm_id === `ALM-${demo.id}`);
    if (!alarm) throw new Error('fixture alarm missing');
    const run = context.repo.createRun({
      id: newId('run'),
      workspaceId: context.workspaceId,
      userId: 'test-user',
      alarmId: alarm.id,
      equipmentId: demo.device,
      window: { start: demo.start, end: isoPlus(demo.start, 30) },
      symptom: demo.symptom,
      dataMode: 'mock',
      modelMode: 'fixture',
      budget: DEFAULT_BUDGET,
      scenarioId: demo.id,
    });
    context.repo.appendEvent(run.id, 'run.created', {
      workspace_id: context.workspaceId,
      equipment_id: run.equipment_id,
      alarm_id: run.alarm_id,
      data_mode: run.data_mode,
      model_mode: run.model_mode,
      scenario_id: demo.id,
    });

    const finished = await orchestrator.execute(run.id, {
      owner: 'test-worker',
    });
    const stored = context.repo.getReport(run.id)!;
    expect(stored.validation.valid).toBe(true);
    expect(stored.report.handoff_reason).toBeNull();
    expect(finished.handoff_reason).toBeNull();
    expect(stored.report.conclusion_status).toBe('hypothesis');
  }, 120_000);

  test('a verifier budget failure with a supported diagnosis still produces a report', async () => {
    const orchestrator = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner: new BudgetExhaustedVerifyRunner(new FixtureRoleRunner()),
      fixturesDir: FIXTURES,
    });
    const demo = DEMO_SCENARIOS[1];
    const alarm = context.repo
      .listAlarms(context.workspaceId)
      .find((item) => item.source_alarm_id === `ALM-${demo.id}`);
    if (!alarm) throw new Error('fixture alarm missing');
    const run = context.repo.createRun({
      id: newId('run'),
      workspaceId: context.workspaceId,
      userId: 'test-user',
      alarmId: alarm.id,
      equipmentId: demo.device,
      window: { start: demo.start, end: isoPlus(demo.start, 30) },
      symptom: demo.symptom,
      dataMode: 'mock',
      modelMode: 'fixture',
      budget: DEFAULT_BUDGET,
      scenarioId: demo.id,
    });
    context.repo.appendEvent(run.id, 'run.created', {
      workspace_id: context.workspaceId,
      equipment_id: run.equipment_id,
      alarm_id: run.alarm_id,
      data_mode: run.data_mode,
      model_mode: run.model_mode,
      scenario_id: demo.id,
    });

    const finished = await orchestrator.execute(run.id, {
      owner: 'test-worker',
    });
    const stored = context.repo.getReport(run.id)!;
    expect(finished.status).toBe('awaiting_human');
    expect(finished.handoff_reason).toBeNull();
    expect(finished.stage).toBe('produce_report');
    expect(stored.validation.valid).toBe(true);
    expect(
      stored.report.hypotheses
        .filter((hypothesis) => hypothesis.status === 'supported')
        .map((hypothesis) => hypothesis.code),
    ).toContain('bearing_wear');
    expect(stored.report.limitations.join(' ')).toContain('输出预算');
    expect(
      context.repo
        .listModelCalls(run.id)
        .some(
          (call) => call.status === 'error' && call.stage === 'verify_evidence',
        ),
    ).toBe(true);
    expect(
      context.repo
        .listEvents(run.id)
        .some(
          (event) =>
            event.type === 'stage.changed' &&
            event.payload.reason === 'budget_fallback',
        ),
    ).toBe(true);
  }, 120_000);

  test('report status drift is reconciled back to the verified hypothesis', async () => {
    const orchestrator = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner: new ReportStatusDriftRunner(new FixtureRoleRunner()),
      fixturesDir: FIXTURES,
    });
    const demo = DEMO_SCENARIOS[1];
    const alarm = context.repo
      .listAlarms(context.workspaceId)
      .find((item) => item.source_alarm_id === `ALM-${demo.id}`);
    if (!alarm) throw new Error('fixture alarm missing');
    const run = context.repo.createRun({
      id: newId('run'),
      workspaceId: context.workspaceId,
      userId: 'test-user',
      alarmId: alarm.id,
      equipmentId: demo.device,
      window: { start: demo.start, end: isoPlus(demo.start, 30) },
      symptom: demo.symptom,
      dataMode: 'mock',
      modelMode: 'fixture',
      budget: DEFAULT_BUDGET,
      scenarioId: demo.id,
    });
    context.repo.appendEvent(run.id, 'run.created', {
      workspace_id: context.workspaceId,
      equipment_id: run.equipment_id,
      alarm_id: run.alarm_id,
      data_mode: run.data_mode,
      model_mode: run.model_mode,
      scenario_id: demo.id,
    });

    await orchestrator.execute(run.id, { owner: 'test-worker' });
    const stored = context.repo.getReport(run.id)!;
    expect(stored.validation.valid).toBe(true);
    expect(
      stored.report.hypotheses.some(
        (hypothesis) =>
          hypothesis.code === 'bearing_wear' &&
          hypothesis.status === 'supported',
      ),
    ).toBe(true);
    expect(
      context.repo
        .listEvents(run.id, 0, 500)
        .some((event) => event.type === 'report.reconciled'),
    ).toBe(true);
  }, 120_000);

  test('a pre-aborted run ends cancelled and keeps collected evidence', async () => {
    const alarm = context.repo
      .listAlarms(context.workspaceId)
      .find((item) => item.source_alarm_id === 'ALM-demo-sensor-drift');
    if (!alarm) throw new Error('alarm missing');
    const run = context.repo.createRun({
      id: newId('run'),
      workspaceId: context.workspaceId,
      userId: 'test-user',
      alarmId: alarm.id,
      equipmentId: 'EQ-DEMO-001',
      window: {
        start: '2026-11-07T00:00:00.000Z',
        end: isoPlus('2026-11-07T00:00:00.000Z', 30),
      },
      symptom: '取消测试',
      dataMode: 'mock',
      modelMode: 'fixture',
      budget: DEFAULT_BUDGET,
      scenarioId: 'demo-sensor-drift',
    });
    const controller = new AbortController();
    controller.abort();
    const finished = await context.orchestrator.execute(run.id, {
      owner: 'test-worker',
      signal: controller.signal,
    });
    expect(finished.status).toBe('cancelled');
    expect(finished.finished_at).toBeTruthy();
    expect(
      context.repo.listEvents(run.id).map((event) => event.type),
    ).toContain('run.cancelled');
  }, 60_000);
});
