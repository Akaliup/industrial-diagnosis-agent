import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runEvalSuite } from '../../src/diagnosis/eval-runner.js';

describe('50-case fixture replay', () => {
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
      expect(summary.live_eval).toContain('NOT_RUN');

      const traces = fs.readdirSync(path.join(dir, 'out', 'traces'));
      expect(traces.length).toBe(50);
      const first = JSON.parse(
        fs.readFileSync(path.join(dir, 'out', 'traces', traces[0]), 'utf8'),
      ) as Record<string, unknown>;
      expect(first).toHaveProperty('case');
      expect(first).toHaveProperty('report');
      expect(first).toHaveProperty('evaluation');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
