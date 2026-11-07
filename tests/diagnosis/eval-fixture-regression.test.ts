import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runEvalSuite } from '../../src/diagnosis/eval-runner.js';
import { FixtureRoleRunner } from '../../src/diagnosis/fixture-role-runner.js';
import {
  RoleRunnerError,
  type RoleCallInput,
  type RoleCallResult,
  type RoleRunner,
} from '../../src/diagnosis/role-runner.js';

describe('50-case fixture regression', () => {
  test('all evaluation cases pass the regression thresholds and leave traces', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnosis-eval-'));
    try {
      const summary = await runEvalSuite({
        split: 'all',
        mode: 'fixture',
        workDir: dir,
        outDir: path.join(dir, 'out'),
        dbFile: path.join(dir, 'eval.db'),
      });
      expect(summary.status).toBe('passed');
      expect(summary.metrics.total).toBe(50);
      expect(summary.metrics.passed).toBe(50);
      expect(summary.threshold_check.ok).toBe(true);
      expect(summary.metrics.unauthorized_calls).toBe(0);
      expect(summary.metrics.missed_handoff).toBe(0);
      expect(summary.metrics.unnecessary_handoff).toBe(0);
      expect(summary.metrics.citation_integrity).toBeGreaterThanOrEqual(0.98);
      expect(summary.metrics.evidence_coverage).toBeGreaterThanOrEqual(0.95);
      expect(summary.metrics.required_tool_recall).toBeGreaterThanOrEqual(0.95);
      expect(summary.metrics.counter_evidence_retained).toBeGreaterThanOrEqual(
        0.95,
      );
      expect(summary.metrics.top3_hit).toBeGreaterThanOrEqual(0.95);
      expect(summary.metrics.top1_hit).toBeGreaterThanOrEqual(0.95);
      expect(summary.metrics.tool_selection_accuracy).toBeGreaterThanOrEqual(
        0.95,
      );
      expect(summary.metrics.handoff_accuracy).toBe(1);
      expect(summary.metrics.task_success_rate).toBe(1);
      expect(summary.metrics.counter_evidence_n).toBe(23);
      expect(summary.metrics.model_calls).toBeGreaterThan(0);
      expect(summary.metrics.total_tokens).toBeGreaterThan(0);
      expect(summary.live_eval).toContain('NOT_RUN');

      const traces = fs.readdirSync(path.join(dir, 'out', 'traces'));
      expect(traces.length).toBe(50);
      const first = JSON.parse(
        fs.readFileSync(path.join(dir, 'out', 'traces', traces[0]), 'utf8'),
      ) as Record<string, unknown>;
      expect(first).toHaveProperty('case');
      expect(first).toHaveProperty('report');
      expect(first).toHaveProperty('evaluation');
      expect(first).toHaveProperty('model_calls');
      expect((first.model_calls as unknown[]).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  test('keeps a per-case trace and model-call audit when a role call fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnosis-eval-fail-'));
    class FailFirstRunner implements RoleRunner {
      readonly mode = 'fixture' as const;
      readonly model = 'test-fail-first';
      private readonly inner = new FixtureRoleRunner();
      private calls = 0;

      async run(input: RoleCallInput): Promise<RoleCallResult> {
        this.calls += 1;
        if (this.calls === 1) {
          throw new RoleRunnerError('simulated model failure', 'MODEL_ERROR');
        }
        return this.inner.run(input);
      }
    }
    try {
      const summary = await runEvalSuite({
        split: 'all',
        limit: 1,
        mode: 'fixture',
        runner: new FailFirstRunner(),
        workDir: dir,
        outDir: path.join(dir, 'out'),
        dbFile: path.join(dir, 'eval.db'),
      });
      expect(summary.status).toBe('failed');
      expect(summary.metrics.total).toBe(1);
      expect(summary.results[0].failure_reasons.join(' ')).toContain(
        'EXECUTION_ERROR',
      );
      const caseId = summary.results[0].case_id;
      const trace = JSON.parse(
        fs.readFileSync(
          path.join(dir, 'out', 'traces', `${caseId}.json`),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(String(trace.execution_error)).toContain('simulated');
      const calls = trace.model_calls as Array<Record<string, unknown>>;
      expect(calls.length).toBeGreaterThan(0);
      expect(String(calls[0].status)).toBe('error');
      expect(String(calls[0].failure_reason)).toContain('simulated');
      expect(summary.metrics.model_call_failures).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
