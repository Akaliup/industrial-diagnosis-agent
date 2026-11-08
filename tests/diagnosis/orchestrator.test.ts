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
import {
  BudgetExceededError,
  DiagnosisOrchestrator,
} from '../../src/diagnosis/orchestrator.js';
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

class CancelDuringBudgetFallbackRunner implements RoleRunner {
  constructor(
    private readonly inner: FixtureRoleRunner,
    private readonly controller: AbortController,
  ) {}

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
      throw new BudgetExceededError('模拟验证预算耗尽');
    }
    if (input.role === 'report_reviewer' && input.stage === 'produce_report') {
      this.controller.abort();
      throw new RoleRunnerError('模型调用已取消', 'CANCELLED');
    }
    return this.inner.run(input);
  }
}

class DatabaseCancelDuringBudgetFallbackRunner implements RoleRunner {
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

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    if (
      input.role === 'hypothesis_verifier' &&
      input.stage === 'verify_evidence'
    ) {
      throw new BudgetExceededError('模拟验证预算耗尽');
    }
    if (input.role === 'report_reviewer' && input.stage === 'produce_report') {
      this.repo.updateRun(input.run.id, { status: 'cancelled' });
      throw new RoleRunnerError('模型调用已取消', 'CANCELLED');
    }
    return this.inner.run(input);
  }
}

class LeaveTemperatureUnexplainedRunner implements RoleRunner {
  constructor(private readonly inner: FixtureRoleRunner) {}

  get mode() {
    return this.inner.mode;
  }

  get model() {
    return this.inner.model;
  }

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    const result = await this.inner.run(input);
    if (
      input.role === 'hypothesis_verifier' &&
      input.stage === 'verify_evidence'
    ) {
      const temperatureIds = new Set(
        input.evidence
          .filter(
            (item) =>
              item.payload.kind === 'telemetry_series' &&
              item.payload.metric === 'bearing_temperature',
          )
          .map((item) => item.id),
      );
      const output = result.output as {
        hypotheses: Array<{
          supporting_evidence_ids: string[];
          contradicting_evidence_ids: string[];
        }>;
      };
      for (const hypothesis of output.hypotheses) {
        hypothesis.supporting_evidence_ids =
          hypothesis.supporting_evidence_ids.filter(
            (id) => !temperatureIds.has(id),
          );
        hypothesis.contradicting_evidence_ids =
          hypothesis.contradicting_evidence_ids.filter(
            (id) => !temperatureIds.has(id),
          );
      }
    }
    return result;
  }
}

class CrashBeforeSecondLookFollowUpRunner implements RoleRunner {
  verifyCalls = 0;
  checkpointAtCrash: Record<string, unknown> | null = null;
  private crashed = false;

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

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    if (
      input.role === 'hypothesis_verifier' &&
      input.stage === 'generate_hypotheses'
    ) {
      // 去掉假设阶段的待办查询，让验证阶段从干净的检查点开始，
      // 从而真正走到二次复核及其跟进复核分支。
      const result = await this.inner.run(input);
      const output = result.output as {
        hypotheses: unknown[];
        next_checks?: unknown[];
      };
      return { ...result, output: { ...output, next_checks: [] } };
    }
    if (
      input.role === 'hypothesis_verifier' &&
      input.stage === 'verify_evidence'
    ) {
      this.verifyCalls += 1;
      if (this.verifyCalls === 3 && !this.crashed) {
        // 模拟 worker 在跟进复核请求发出前后崩溃：请求前的检查点已经落库，
        // 但跟进结果尚未写入。
        this.crashed = true;
        this.checkpointAtCrash =
          this.repo.getRun(input.run.id)?.checkpoint ?? null;
        throw new Error('模拟 worker 在跟进复核前崩溃');
      }
      const result = await this.inner.run(input);
      if (this.verifyCalls === 2) {
        // 二次复核返回一个待办查询，触发跟进复核分支。
        const output = result.output as {
          hypotheses: unknown[];
          next_checks?: unknown[];
        };
        return {
          ...result,
          output: {
            ...output,
            next_checks: [
              {
                tool: 'equipment_query',
                args: {
                  equipment_id: input.equipment.equipment_id,
                  query_kind: 'status',
                  window: input.run.window,
                },
                target_hypothesis: null,
                evidence_gap: '二次复核缺少设备状态佐证',
                expected_discrimination: '确认设备状态是否支持机械故障',
                rationale: '补充状态证据后再做最终复核',
              },
            ],
          },
        };
      }
      return result;
    }
    return this.inner.run(input);
  }
}

class CrashDuringSecondLookRunner implements RoleRunner {
  verifyCalls = 0;
  checkpointAtCrash: Record<string, unknown> | null = null;
  private crashed = false;

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

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    if (
      input.role === 'hypothesis_verifier' &&
      input.stage === 'generate_hypotheses'
    ) {
      const result = await this.inner.run(input);
      const output = result.output as {
        hypotheses: unknown[];
        next_checks?: unknown[];
      };
      return { ...result, output: { ...output, next_checks: [] } };
    }
    if (
      input.role === 'hypothesis_verifier' &&
      input.stage === 'verify_evidence'
    ) {
      this.verifyCalls += 1;
      if (this.verifyCalls === 2 && !this.crashed) {
        // 模拟 worker 在二次复核调用中途崩溃：调用前的检查点已经落库，
        // 但二次复核的假设和 next_checks 都还没有写入。
        this.crashed = true;
        this.checkpointAtCrash =
          this.repo.getRun(input.run.id)?.checkpoint ?? null;
        throw new Error('模拟 worker 在二次复核调用中崩溃');
      }
      return this.inner.run(input);
    }
    return this.inner.run(input);
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

  test('a control-intent request keeps its handoff reason during budget fallback', async () => {
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
      symptom: '请复位设备并检查轴承温度持续上升',
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
    expect(stored.validation.valid).toBe(true);
    expect(stored.report.handoff_reason).toContain('控制/复位');
    expect(finished.handoff_reason).toContain('控制/复位');
    expect(
      stored.report.hypotheses.some(
        (hypothesis) =>
          hypothesis.code === 'bearing_wear' &&
          hypothesis.status === 'supported',
      ),
    ).toBe(true);
    expect(stored.report.limitations.join(' ')).toContain('输出预算');
  }, 120_000);

  test('an optional second look does not consume the last report round', async () => {
    const orchestrator = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner: new LeaveTemperatureUnexplainedRunner(new FixtureRoleRunner()),
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
      budget: { ...DEFAULT_BUDGET, max_rounds_total: 6 },
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
    expect(finished.total_rounds).toBe(6);
    // 6 轮预算下，二次复核被跳过，最后一轮留给报告。
    expect(finished.stage_rounds.verify_evidence).toBe(1);
    expect(stored.validation.valid).toBe(true);
    expect(
      stored.report.hypotheses.some(
        (hypothesis) =>
          hypothesis.code === 'bearing_wear' &&
          hypothesis.status === 'supported',
      ),
    ).toBe(true);
  }, 120_000);

  test('recovery redoes the second-look follow-up after a worker crash', async () => {
    const runner = new CrashBeforeSecondLookFollowUpRunner(
      new LeaveTemperatureUnexplainedRunner(new FixtureRoleRunner()),
      context.repo,
    );
    const orchestrator = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner,
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

    const crashed = await orchestrator.execute(run.id, {
      owner: 'crash-worker',
    });
    expect(crashed.status).toBe('failed');
    // 崩溃前的检查点必须保留“仍需最终复核”，否则恢复会直接出报告。
    expect(runner.checkpointAtCrash?.second_look_in_progress).toBe(true);
    expect(runner.checkpointAtCrash?.verify_needs_final_call).toBe(true);
    expect(runner.checkpointAtCrash?.pending_checks).toBeUndefined();

    // 硬崩溃不会落终态；模拟重启后的租约接管。
    context.repo.updateRun(run.id, {
      status: 'running',
      error: null,
      finished_at: null,
      lease_expires_at: '2000-01-01T00:00:00.000Z',
    });
    const leaseToken = context.repo.claimRun(run.id, 'recovery-worker', 60_000);
    expect(leaseToken).not.toBeNull();

    const recovered = await orchestrator.execute(run.id, {
      owner: 'recovery-worker',
    });
    // 初始复核、二次复核、崩溃的跟进请求、恢复后的跟进复核。
    expect(runner.verifyCalls).toBe(4);
    expect(recovered.status).toBe('awaiting_human');
    expect(recovered.checkpoint?.verify_needs_final_call).toBeUndefined();
    expect(recovered.checkpoint?.second_look_in_progress).toBeUndefined();
    expect(recovered.stage_rounds.verify_evidence).toBe(3);
    expect(context.repo.getReport(run.id)?.validation.valid).toBe(true);
  }, 120_000);

  test('recovery redoes the second look after a worker crash', async () => {
    const runner = new CrashDuringSecondLookRunner(
      new LeaveTemperatureUnexplainedRunner(new FixtureRoleRunner()),
      context.repo,
    );
    const orchestrator = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner,
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

    const crashed = await orchestrator.execute(run.id, {
      owner: 'crash-worker',
    });
    expect(crashed.status).toBe('failed');
    // 二次复核开始前只落库“进行中”，不能提前标记完成；否则恢复会跳过
    // 被中断的复核并直接报告旧假设。
    expect(runner.checkpointAtCrash?.second_look_in_progress).toBe(true);
    expect(runner.checkpointAtCrash?.second_look_done).toBeUndefined();
    expect(runner.checkpointAtCrash?.verify_needs_final_call).toBeUndefined();
    expect(
      (runner.checkpointAtCrash?.pending_checks as unknown[] | undefined) ?? [],
    ).toEqual([]);

    context.repo.updateRun(run.id, {
      status: 'running',
      error: null,
      finished_at: null,
      lease_expires_at: '2000-01-01T00:00:00.000Z',
    });
    const leaseToken = context.repo.claimRun(run.id, 'recovery-worker', 60_000);
    expect(leaseToken).not.toBeNull();

    const recovered = await orchestrator.execute(run.id, {
      owner: 'recovery-worker',
    });
    // 初始复核、崩溃的二次复核、恢复后重做的二次复核。
    expect(runner.verifyCalls).toBe(3);
    expect(recovered.status).toBe('awaiting_human');
    expect(recovered.checkpoint?.second_look_done).toBe(true);
    expect(recovered.checkpoint?.second_look_in_progress).toBeUndefined();
    expect(recovered.stage_rounds.verify_evidence).toBe(2);
    expect(context.repo.getReport(run.id)?.validation.valid).toBe(true);
  }, 120_000);

  test('aborting during the budget-fallback report keeps the run cancelled', async () => {
    const controller = new AbortController();
    const orchestrator = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner: new CancelDuringBudgetFallbackRunner(
        new FixtureRoleRunner(),
        controller,
      ),
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
      signal: controller.signal,
    });
    expect(finished.status).toBe('cancelled');
    expect(finished.handoff_reason).toBeNull();
    expect(context.repo.getReport(run.id)).toBeNull();
    const events = context.repo.listEvents(run.id).map((event) => event.type);
    expect(events).toContain('run.cancelled');
    expect(events).not.toContain('report.ready');
    expect(events).not.toContain('run.awaiting_human');
  }, 120_000);

  test('a cancelled database state is not overwritten by the budget-fallback report', async () => {
    const orchestrator = new DiagnosisOrchestrator({
      repo: context.repo,
      knowledge: context.knowledge,
      bus: new DiagnosisEventBus(),
      runner: new DatabaseCancelDuringBudgetFallbackRunner(
        new FixtureRoleRunner(),
        context.repo,
      ),
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
    expect(finished.status).toBe('cancelled');
    expect(context.repo.getRun(run.id)?.status).toBe('cancelled');
    expect(context.repo.getReport(run.id)).toBeNull();
    expect(
      context.repo.listEvents(run.id).map((event) => event.type),
    ).not.toContain('report.ready');
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
