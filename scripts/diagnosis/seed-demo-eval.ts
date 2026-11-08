/**
 * 把一次真实的 Fixture 50 例评测结果写入演示数据库。
 *
 * 评测仍在独立的临时数据库中运行（与 `diagnosis:eval:gate` 相同的数据集和
 * 评分逻辑），完成后只把 `diagnosis_eval_runs` 结果行复制到目标演示库。
 * Trace 文件位于 `work/diagnosis/eval/<evalRunId>/traces`，评测与回放页面
 * 通过现有只读接口读取。该脚本只用于 E2E/演示数据准备，不参与产品运行时。
 */
import '../../src/diagnosis/load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runEvalSuite } from '../../src/diagnosis/eval-runner.js';

const targetArg = process.argv[2];
if (!targetArg) {
  throw new Error(
    'usage: tsx scripts/diagnosis/seed-demo-eval.ts <target-demo-db>',
  );
}

const root = process.cwd();
const targetDbPath = path.resolve(root, targetArg);
if (!fs.existsSync(targetDbPath)) {
  throw new Error(`目标演示库不存在：${targetDbPath}`);
}
const seedDbPath = path.resolve(
  root,
  'work/diagnosis',
  `seed-eval-${Date.now()}.db`,
);

const summary = await runEvalSuite({
  split: 'all',
  mode: 'fixture',
  dbFile: seedDbPath,
});

const seed = new Database(seedDbPath, { readonly: true });
const row = seed
  .prepare('SELECT * FROM diagnosis_eval_runs WHERE id = ?')
  .get(summary.eval_run_id) as Record<string, unknown> | undefined;
seed.close();
if (!row) throw new Error('评测结果行缺失');

const target = new Database(targetDbPath);
target.pragma('busy_timeout = 10000');
target
  .prepare(
    `INSERT OR REPLACE INTO diagnosis_eval_runs
       (id, mode, split, status, started_at, finished_at, metrics_json, results_json, error)
     VALUES
       (@id, @mode, @split, @status, @started_at, @finished_at, @metrics_json, @results_json, @error)`,
  )
  .run(row);
target.close();
fs.rmSync(seedDbPath, { force: true });

console.log(
  JSON.stringify(
    {
      eval_run_id: row.id,
      status: row.status,
      traces: summary.traces,
      target: targetDbPath,
    },
    null,
    2,
  ),
);
