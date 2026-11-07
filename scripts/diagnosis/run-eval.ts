import '../../src/diagnosis/load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  EvalNotRunError,
  runEvalSuite,
} from '../../src/diagnosis/eval-runner.js';
import type { ModelMode } from '../../src/diagnosis/contracts/domain.js';
import { nowIso } from '../../src/diagnosis/util.js';

interface Args {
  split: 'dev' | 'holdout' | 'all';
  limit: number | null;
  mode: ModelMode;
  gate: boolean;
  out: string | null;
  db: string | null;
  evalDir: string | null;
  fixturesDir: string | null;
  cases: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    split: 'all',
    limit: null,
    mode: 'fixture',
    gate: false,
    out: null,
    db: null,
    evalDir: null,
    fixturesDir: null,
    cases: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--split') {
      const value = argv[++index];
      if (value === 'dev' || value === 'holdout' || value === 'all') {
        args.split = value;
      }
    } else if (arg === '--limit') {
      const value = Number(argv[++index]);
      if (Number.isFinite(value) && value > 0) args.limit = value;
    } else if (arg === '--mode') {
      const value = argv[++index];
      if (value === 'fixture' || value === 'live') args.mode = value;
    } else if (arg === '--gate') {
      args.gate = true;
    } else if (arg === '--out') {
      args.out = argv[++index] ?? null;
    } else if (arg === '--db') {
      args.db = argv[++index] ?? null;
    } else if (arg === '--eval-dir') {
      args.evalDir = argv[++index] ?? null;
    } else if (arg === '--fixtures-dir') {
      args.fixturesDir = argv[++index] ?? null;
    } else if (arg === '--case') {
      const value = argv[++index];
      if (value) args.cases.push(value);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    const summary = await runEvalSuite({
      split: args.split,
      limit: args.limit,
      caseIds: args.cases,
      mode: args.mode,
      outDir: args.out ?? undefined,
      dbFile: args.db ?? undefined,
      evalDir: args.evalDir ?? undefined,
      fixturesDir: args.fixturesDir ?? undefined,
      onCase: (result) => {
        console.log(
          `${result.case_id} ${result.passed ? 'PASS' : 'FAIL'}${
            result.passed ? '' : ` ${result.failure_reasons.join('; ')}`
          }`,
        );
      },
    });
    console.log('');
    console.log(JSON.stringify(summary, null, 2));
    if (summary.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    if (error instanceof EvalNotRunError) {
      const outDir =
        args.out ??
        path.join('work/diagnosis', `live-eval-not-run-${Date.now()}`);
      fs.mkdirSync(outDir, { recursive: true });
      const payload = {
        status: 'NOT_RUN',
        mode: 'live',
        reason: error.message,
        at: nowIso(),
      };
      fs.writeFileSync(
        path.join(outDir, 'summary.json'),
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );
      console.log(JSON.stringify(payload, null, 2));
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
