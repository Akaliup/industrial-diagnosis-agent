import type {
  EvalCaseResult,
  Evidence,
  Hypothesis,
  Report,
  Run,
} from './contracts/domain.js';
import {
  evaluateCase,
  type EvalCaseFile,
  type EvalGoldFile,
  type ToolCallView,
} from './eval.js';

/**
 * Eval trace 的只读回放。
 *
 * 回放只消费已经落盘的 trace：不启动 MCP、不调用模型、不重新执行诊断。
 * 它校验报告引用、证据作用域、假设状态，并用存储的报告/证据/工具调用重算评分。
 */
export interface DiagnosisTrace {
  case: EvalCaseFile;
  gold: EvalGoldFile;
  run: Run;
  events: Array<{ seq: number; type: string }>;
  tool_calls: Array<Record<string, unknown>>;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  context_manifests: Array<Record<string, unknown>>;
  report: { report: Report; validation: unknown } | null;
  evaluation: EvalCaseResult;
}

export interface ReplayCheck {
  name: string;
  ok: boolean;
  detail: string | null;
}

export interface TraceReplayResult {
  case_id: string;
  consistent: boolean;
  checks: ReplayCheck[];
}

function check(
  name: string,
  ok: boolean,
  detail: string | null = null,
): ReplayCheck {
  return { name, ok, detail };
}

function toolCallView(row: Record<string, unknown>): ToolCallView {
  return {
    tool: String(row.tool),
    status: String(row.status),
    policy_decision: String(row.policy_decision),
    error_code: (row.error_code as string | null) ?? null,
    role: typeof row.role === 'string' ? row.role : undefined,
    args_json: typeof row.args_json === 'string' ? row.args_json : undefined,
  };
}

export function replayTrace(trace: DiagnosisTrace): TraceReplayResult {
  const checks: ReplayCheck[] = [];
  const report = trace.report?.report ?? null;
  const evidenceById = new Map(trace.evidence.map((item) => [item.id, item]));

  checks.push(
    check(
      'report_present',
      Boolean(report),
      report ? null : 'trace 中没有报告',
    ),
  );
  checks.push(
    check(
      'report_run_id',
      Boolean(report) && report!.run_id === trace.run.id,
      report ? `report=${report.run_id} run=${trace.run.id}` : null,
    ),
  );

  const evidenceScopeOk = trace.evidence.every(
    (item) =>
      item.run_id === trace.run.id &&
      item.workspace_id === trace.run.workspace_id,
  );
  checks.push(
    check(
      'evidence_scope',
      evidenceScopeOk,
      evidenceScopeOk ? null : '存在跨 Run/工作区的证据',
    ),
  );

  const citations = new Set<string>();
  if (report) {
    for (const observation of report.observations) {
      for (const id of observation.evidence_ids) citations.add(id);
    }
    for (const item of report.checks) {
      for (const id of item.evidence_ids) citations.add(id);
    }
    for (const item of report.recommendations) {
      for (const id of item.evidence_ids) citations.add(id);
    }
    for (const hypothesis of report.hypotheses) {
      for (const id of hypothesis.supporting_evidence_ids) citations.add(id);
      for (const id of hypothesis.contradicting_evidence_ids) citations.add(id);
    }
  }
  const missingCitations = [...citations].filter((id) => !evidenceById.has(id));
  checks.push(
    check(
      'citations_exist',
      missingCitations.length === 0,
      missingCitations.length > 0
        ? `缺少证据：${missingCitations.slice(0, 5).join(',')}`
        : null,
    ),
  );

  const reportHypotheses = new Map(
    (report?.hypotheses ?? []).map((item) => [item.code, item.status]),
  );
  const hypothesisMismatch = trace.hypotheses.filter(
    (item) => reportHypotheses.get(item.code) !== item.status,
  );
  checks.push(
    check(
      'hypothesis_status',
      hypothesisMismatch.length === 0,
      hypothesisMismatch.length > 0
        ? `状态不一致：${hypothesisMismatch.map((item) => item.code).join(',')}`
        : null,
    ),
  );

  const eventSequences = trace.events.map((event) => event.seq);
  const eventsSequential = eventSequences.every(
    (seq, index) => seq === index + 1,
  );
  checks.push(
    check(
      'event_sequence',
      eventsSequential,
      eventsSequential ? null : `事件序号不连续：${eventSequences.join(',')}`,
    ),
  );

  const recomputed = evaluateCase({
    gold: trace.gold,
    run: trace.run,
    report,
    validation: trace.report?.validation ?? null,
    evidence: trace.evidence,
    toolCalls: trace.tool_calls.map(toolCallView),
  });
  const stored = trace.evaluation;
  const evaluationMatches =
    stored.passed === recomputed.passed &&
    JSON.stringify(stored.failure_reasons) ===
      JSON.stringify(recomputed.failureReasons) &&
    JSON.stringify([...stored.predicted_root_causes].sort()) ===
      JSON.stringify([...recomputed.result.predicted_root_causes].sort()) &&
    JSON.stringify([...stored.required_tools_missing].sort()) ===
      JSON.stringify([...recomputed.result.required_tools_missing].sort()) &&
    JSON.stringify([...stored.citation_issues].sort()) ===
      JSON.stringify([...recomputed.result.citation_issues].sort()) &&
    JSON.stringify(stored.metrics) ===
      JSON.stringify(recomputed.result.metrics);
  checks.push(
    check(
      'evaluation_recomputed',
      evaluationMatches,
      evaluationMatches
        ? null
        : `存储 passed=${stored.passed}，重算 passed=${recomputed.passed}`,
    ),
  );

  return {
    case_id: trace.case.case_id,
    consistent: checks.every((item) => item.ok),
    checks,
  };
}
