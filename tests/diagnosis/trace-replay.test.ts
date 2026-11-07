import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runEvalSuite } from '../../src/diagnosis/eval-runner.js';
import {
  replayTrace,
  type DiagnosisTrace,
} from '../../src/diagnosis/replay.js';

describe('trace replay', () => {
  test('replays a stored trace without inference or tool execution', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnosis-replay-'));
    try {
      await runEvalSuite({
        split: 'all',
        limit: 1,
        mode: 'fixture',
        workDir: dir,
        outDir: path.join(dir, 'out'),
        dbFile: path.join(dir, 'eval.db'),
        evalRunId: 'replay-test',
      });
      const traceDir = path.join(dir, 'out', 'traces');
      const files = fs.readdirSync(traceDir);
      expect(files).toHaveLength(1);
      const trace = JSON.parse(
        fs.readFileSync(path.join(traceDir, files[0]), 'utf8'),
      ) as DiagnosisTrace;

      const result = replayTrace(trace);
      expect(result.consistent, JSON.stringify(result.checks)).toBe(true);
      expect(result.checks.map((item) => item.name)).toContain(
        'evaluation_recomputed',
      );

      // 篡改引用必须被回放识别，而不是无条件通过。
      const missingCitation = structuredClone(trace);
      missingCitation.report!.report.observations[0].evidence_ids.push(
        'ev_missing_from_trace',
      );
      const citationResult = replayTrace(missingCitation);
      expect(citationResult.consistent).toBe(false);
      expect(
        citationResult.checks.find((item) => item.name === 'citations_exist')
          ?.ok,
      ).toBe(false);

      // 篡改评分也必须被重算发现。
      const staleEvaluation = structuredClone(trace);
      staleEvaluation.evaluation.passed = !staleEvaluation.evaluation.passed;
      const evaluationResult = replayTrace(staleEvaluation);
      expect(evaluationResult.consistent).toBe(false);
      expect(
        evaluationResult.checks.find(
          (item) => item.name === 'evaluation_recomputed',
        )?.ok,
      ).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
