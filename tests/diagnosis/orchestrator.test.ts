import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  closeContext,
  createSeededContext,
  DEMO_SCENARIOS,
  isoPlus,
  runDemo,
  type TestContext,
} from './helpers.js';
import { newId } from '../../src/diagnosis/util.js';
import { DEFAULT_BUDGET } from '../../src/diagnosis/contracts/domain.js';

let context: TestContext;

beforeAll(async () => {
  context = await createSeededContext('diagnosis-orchestrator');
}, 120_000);

afterAll(() => {
  closeContext(context);
});

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
