/**
 * 只读回放已落盘的 Eval trace：不启动 MCP、不调用模型、不重新推理。
 *
 * 用法：
 *   npx tsx scripts/diagnosis/replay.ts <trace.json|traces目录>
 * 默认读取 work/diagnosis/eval 下最新的 traces 目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  replayTrace,
  type DiagnosisTrace,
} from '../../src/diagnosis/replay.js';

function latestTraceDir(): string {
  const root = path.resolve('work/diagnosis/eval');
  const candidates = fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name, 'traces'))
        .filter((dir) => fs.existsSync(dir))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : [];
  if (candidates.length === 0) {
    throw new Error('没有找到 Eval trace；先运行 npm run diagnosis:eval');
  }
  return candidates[0];
}

function traceFiles(target: string): string[] {
  if (fs.statSync(target).isFile()) return [target];
  return fs
    .readdirSync(target)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(target, name));
}

function main(): void {
  const target = path.resolve(process.argv[2] ?? latestTraceDir());
  const files = traceFiles(target);
  const results = files.map((file) => {
    const trace = JSON.parse(fs.readFileSync(file, 'utf8')) as DiagnosisTrace;
    return { file, ...replayTrace(trace) };
  });
  for (const result of results) {
    const failed = result.checks.filter((item) => !item.ok);
    console.log(
      `${result.case_id}: ${result.consistent ? 'OK' : 'INCONSISTENT'}${
        failed.length > 0
          ? ` (${failed.map((item) => `${item.name}:${item.detail ?? ''}`).join('; ')})`
          : ''
      }`,
    );
  }
  const inconsistent = results.filter((result) => !result.consistent).length;
  console.log(
    `replayed=${results.length} inconsistent=${inconsistent} inference_calls=0 tool_calls=0`,
  );
  if (inconsistent > 0) process.exitCode = 1;
}

main();
