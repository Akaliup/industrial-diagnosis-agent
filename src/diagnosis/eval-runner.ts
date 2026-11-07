import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateDiagnosis } from './db.js';
import {
  aggregateMetrics,
  checkThresholds,
  evaluateCase,
  type EvalCaseFile,
  type EvalGoldFile,
  type EvalThresholds,
} from './eval.js';
import type { EvalCaseResult } from './contracts/domain.js';
import { DiagnosisEventBus } from './events.js';
import { FixtureRoleRunner } from './fixture-role-runner.js';
import { KnowledgeService } from './knowledge.js';
import { createRoleRunner, liveOptionsFromEnv } from './live-role-runner.js';
import { DiagnosisOrchestrator } from './orchestrator.js';
import { DiagnosisRepository } from './repository.js';
import { seedDiagnosis } from './seed.js';
import { DEFAULT_BUDGET, type ModelMode } from './contracts/domain.js';
import { newId, nowIso, sha256 } from './util.js';

export interface EvalRunOptions {
  split: 'dev' | 'holdout' | 'all';
  limit?: number | null;
  mode: ModelMode;
  evalRunId?: string;
  fixturesDir?: string;
  evalDir?: string;
  workDir?: string;
  outDir?: string;
  dbFile?: string;
  onCase?: (result: {
    case_id: string;
    passed: boolean;
    failure_reasons: string[];
  }) => void;
}

export interface EvalRunSummary {
  eval_run_id: string;
  mode: ModelMode;
  split: string;
  status: 'passed' | 'failed';
  started_from: string | null;
  metrics: ReturnType<typeof aggregateMetrics>;
  threshold_check: { ok: boolean; failures: string[] };
  results: Array<{
    case_id: string;
    passed: boolean;
    failure_reasons: string[];
  }>;
  case_results: EvalCaseResult[];
  db: string;
  traces: string;
  live_eval: string;
}

export class EvalNotRunError extends Error {
  readonly code = 'EVAL_NOT_RUN';
  constructor(message: string) {
    super(message);
    this.name = 'EvalNotRunError';
  }
}

interface ScenarioAlarm {
  source_id: string;
  source_alarm_id: string;
  equipment_id: string;
  code: string;
  severity: string;
  state: string;
  raised_at: string;
  cleared_at: string | null;
  message: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function loadCases(
  evalDir: string,
  split: EvalRunOptions['split'],
): Array<{ caseFile: EvalCaseFile; gold: EvalGoldFile }> {
  const caseDir = path.join(evalDir, 'cases');
  const goldDir = path.join(evalDir, 'gold');
  const files = fs
    .readdirSync(caseDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const result: Array<{ caseFile: EvalCaseFile; gold: EvalGoldFile }> = [];
  for (const file of files) {
    const caseFile = readJson<EvalCaseFile>(path.join(caseDir, file));
    if (split !== 'all' && caseFile.split !== split) continue;
    const gold = readJson<EvalGoldFile>(path.join(goldDir, file));
    result.push({ caseFile, gold });
  }
  return result;
}

function scenarioAlarm(
  fixturesDir: string,
  scenarioId: string,
): ScenarioAlarm | null {
  const file = path.join(fixturesDir, 'scenarios', `${scenarioId}.json`);
  if (!fs.existsSync(file)) return null;
  const overlay = readJson<{ alarms?: unknown[] }>(file);
  const alarm = overlay.alarms?.[0];
  if (!alarm || typeof alarm !== 'object') return null;
  return alarm as ScenarioAlarm;
}

function markdownSummary(input: {
  evalRunId: string;
  mode: ModelMode;
  split: string;
  metrics: ReturnType<typeof aggregateMetrics>;
  results: Array<{
    case_id: string;
    passed: boolean;
    failure_reasons: string[];
  }>;
  thresholdFailures: string[];
}): string {
  const lines = [
    `# 设备智诊 Eval ${input.evalRunId}`,
    '',
    `- 模式：${input.mode}`,
    `- 拆分：${input.split}`,
    `- 用例：${input.metrics.total}`,
    `- 通过：${input.metrics.passed}`,
    `- 时间：${nowIso()}`,
    '',
    '## 指标',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| citation_integrity | ${input.metrics.citation_integrity} |`,
    `| evidence_coverage | ${input.metrics.evidence_coverage} |`,
    `| required_tool_recall | ${input.metrics.required_tool_recall} |`,
    `| top3_hit | ${input.metrics.top3_hit} |`,
    `| counter_evidence_retained | ${input.metrics.counter_evidence_retained} |`,
    `| solvable_completion | ${input.metrics.solvable_completion} |`,
    `| multi_fault_coverage | ${input.metrics.multi_fault_coverage ?? 'n/a'} |`,
    `| unauthorized_calls | ${input.metrics.unauthorized_calls} |`,
    `| missed_handoff | ${input.metrics.missed_handoff} |`,
    `| unnecessary_handoff | ${input.metrics.unnecessary_handoff} |`,
    '',
  ];
  const failures = input.results.filter((result) => !result.passed);
  lines.push('## 失败用例', '');
  if (failures.length === 0) lines.push('无');
  for (const failure of failures) {
    lines.push(`- ${failure.case_id}: ${failure.failure_reasons.join('; ')}`);
  }
  if (input.thresholdFailures.length > 0) {
    lines.push('', '## 门禁失败', '');
    for (const failure of input.thresholdFailures) lines.push(`- ${failure}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 运行 50 个 Eval 用例（dev/holdout/all），返回指标与门禁结果。
 *
 * 每次运行使用独立临时数据库，不污染主库；trace 写入
 * `<workDir>/eval/<eval_run_id>/traces/<case_id>.json`，供回放与 API 查询。
 */
export async function runEvalSuite(
  options: EvalRunOptions,
): Promise<EvalRunSummary> {
  if (options.mode === 'live' && !liveOptionsFromEnv()) {
    throw new EvalNotRunError(
      '未配置 DIAGNOSIS_LLM_BASE_URL / DIAGNOSIS_LLM_API_KEY / DIAGNOSIS_LLM_MODEL；Live Eval 未运行。',
    );
  }
  const root = process.cwd();
  const fixturesDir = path.resolve(
    options.fixturesDir ?? path.join(root, 'fixtures/diagnosis'),
  );
  const evalDir = path.resolve(
    options.evalDir ?? path.join(root, 'evals/diagnosis'),
  );
  const workDir = path.resolve(
    options.workDir ?? path.join(root, 'work/diagnosis'),
  );
  const evalRunId =
    options.evalRunId ?? `eval_${Date.now().toString(36)}_${options.split}`;
  const outDir = path.resolve(
    options.outDir ?? path.join(workDir, 'eval', evalRunId),
  );
  const traceDir = path.join(outDir, 'traces');
  fs.mkdirSync(traceDir, { recursive: true });
  const dbFile = path.resolve(
    options.dbFile ?? path.join(workDir, `eval-${Date.now()}.db`),
  );
  if (fs.existsSync(dbFile)) fs.rmSync(dbFile, { force: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  try {
    const migration = migrateDiagnosis(db, {
      backupDir: path.join(workDir, 'backups'),
    });
    const repo = new DiagnosisRepository(db);
    const knowledge = new KnowledgeService(repo, {
      fixturesDir,
      ftsAvailable: Boolean(
        migration.tokenizer && migration.tokenizer !== 'none',
      ),
    });
    const workspaceId = `ws-eval-${evalRunId}`;
    await seedDiagnosis({
      repo,
      knowledge,
      workspaceId,
      fixturesDir,
    });
    repo.createEvalRun({
      id: evalRunId,
      mode: options.mode,
      split: options.split,
    });
    const runner =
      options.mode === 'fixture'
        ? new FixtureRoleRunner()
        : createRoleRunner('live');
    const orchestrator = new DiagnosisOrchestrator({
      repo,
      knowledge,
      bus: new DiagnosisEventBus(),
      runner,
      fixturesDir,
    });

    const cases = loadCases(evalDir, options.split);
    const selected = options.limit ? cases.slice(0, options.limit) : cases;
    if (selected.length === 0) {
      throw new Error('没有可运行的评测用例');
    }
    const results: EvalRunSummary['results'] = [];
    const caseResults: EvalCaseResult[] = [];
    for (const { caseFile, gold } of selected) {
      const alarm = scenarioAlarm(fixturesDir, caseFile.source_snapshot);
      if (!alarm) throw new Error(`场景缺少报警：${caseFile.source_snapshot}`);
      const idempotencyKey = `eval|${caseFile.case_id}|${alarm.raised_at}`;
      const storedAlarm = repo.upsertAlarm({
        id: `alm_${sha256(idempotencyKey).slice(0, 20)}`,
        workspaceId,
        sourceId: alarm.source_id,
        sourceAlarmId: alarm.source_alarm_id,
        equipmentId: alarm.equipment_id,
        code: alarm.code,
        severity: alarm.severity,
        state: alarm.state,
        raisedAt: alarm.raised_at,
        clearedAt: alarm.cleared_at,
        message: alarm.message,
        dataMode: 'mock',
        idempotencyKey,
        scenarioId: caseFile.source_snapshot,
      }).alarm;
      const run = repo.createRun({
        id: newId('run'),
        workspaceId,
        userId: 'eval',
        alarmId: storedAlarm.id,
        equipmentId: caseFile.input.equipment_id,
        window: caseFile.input.window,
        symptom: caseFile.input.symptom,
        dataMode: 'mock',
        modelMode: options.mode,
        budget: DEFAULT_BUDGET,
        scenarioId: caseFile.source_snapshot,
      });
      const finished = await orchestrator.execute(run.id, {
        owner: `eval-${caseFile.case_id}`,
      });
      const reportRecord = repo.getReport(run.id);
      const toolCalls = repo.listToolCalls(run.id).map((row) => ({
        tool: String(row.tool),
        status: String(row.status),
        policy_decision: String(row.policy_decision),
        error_code: (row.error_code as string | null) ?? null,
      }));
      const evaluation = evaluateCase({
        gold,
        run: finished,
        report: reportRecord?.report ?? null,
        validation: reportRecord?.validation ?? null,
        evidence: repo.listEvidence(run.id),
        toolCalls,
      });
      caseResults.push(evaluation.result);
      results.push({
        case_id: gold.case_id,
        passed: evaluation.passed,
        failure_reasons: evaluation.failureReasons,
      });
      options.onCase?.(results[results.length - 1]);
      const trace = {
        case: caseFile,
        gold,
        run: finished,
        events: repo.listEvents(run.id),
        tool_calls: repo.listToolCalls(run.id),
        evidence: repo.listEvidence(run.id),
        hypotheses: repo.listHypotheses(run.id),
        context_manifests: repo.listManifests(run.id),
        report: reportRecord,
        evaluation: evaluation.result,
      };
      fs.writeFileSync(
        path.join(traceDir, `${caseFile.case_id}.json`),
        `${JSON.stringify(trace, null, 2)}\n`,
        'utf8',
      );
    }
    const metrics = aggregateMetrics(caseResults);
    const thresholdsFile = path.join(evalDir, 'thresholds.json');
    const thresholds = fs.existsSync(thresholdsFile)
      ? readJson<EvalThresholds>(thresholdsFile)
      : null;
    const thresholdCheck = thresholds
      ? checkThresholds(metrics, thresholds)
      : { ok: true, failures: [] as string[] };
    const status =
      results.every((result) => result.passed) && thresholdCheck.ok
        ? 'passed'
        : 'failed';
    repo.finishEvalRun({
      id: evalRunId,
      status,
      metrics,
      results: caseResults,
      error: thresholdCheck.ok ? null : thresholdCheck.failures.join('; '),
    });
    const summary: EvalRunSummary = {
      eval_run_id: evalRunId,
      mode: options.mode,
      split: options.split,
      status,
      started_from: caseResults[0]?.run_id ?? null,
      metrics,
      threshold_check: thresholdCheck,
      results,
      case_results: caseResults,
      db: path.relative(root, dbFile).replaceAll('\\', '/'),
      traces: path.relative(root, traceDir).replaceAll('\\', '/'),
      live_eval: options.mode === 'live' ? 'RUN' : 'NOT_RUN (未配置真实模型)',
    };
    fs.writeFileSync(
      path.join(outDir, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(outDir, 'report.md'),
      markdownSummary({
        evalRunId,
        mode: options.mode,
        split: options.split,
        metrics,
        results,
        thresholdFailures: thresholdCheck.failures,
      }),
      'utf8',
    );
    return summary;
  } finally {
    db.close();
  }
}

export function evalTracePath(
  evalRunId: string,
  caseId: string,
  workDir = path.join(process.cwd(), 'work/diagnosis'),
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(caseId)) {
    throw new Error('非法 case_id');
  }
  return path.join(workDir, 'eval', evalRunId, 'traces', `${caseId}.json`);
}
