import { describe, expect, test } from 'vitest';
import {
  aggregateMetrics,
  checkThresholds,
  evaluateCase,
  type EvalGoldFile,
  type EvalThresholds,
  type ToolCallView,
} from '../../src/diagnosis/eval.js';
import type {
  Evidence,
  Report,
  Run,
} from '../../src/diagnosis/contracts/domain.js';

const run = {
  id: 'run_scorer',
  equipment_id: 'EQ-1',
  status: 'awaiting_human',
} as Run;

const evidence: Evidence[] = [
  {
    id: 'ev_temp',
    workspace_id: 'ws',
    run_id: run.id,
    source_id: 'src-scada',
    source_kind: 'scada',
    data_mode: 'mock',
    equipment_id: 'EQ-1',
    observed_at: '2026-11-07T00:00:00.000Z',
    fetched_at: '2026-11-07T00:00:00.000Z',
    source_record_id: 'temp',
    payload_hash: 'a'.repeat(64),
    query_hash: 'b'.repeat(64),
    locator: { kind: 'db', ref: 'temp' },
    quality_flags: ['good'],
    payload: {
      kind: 'telemetry_series',
      equipment_id: 'EQ-1',
      metric: 'bearing_temperature',
      unit: 'C',
      points: [
        { t: '2026-11-07T00:00:00.000Z', v: 60, q: 'good' },
        { t: '2026-11-07T00:01:00.000Z', v: 70, q: 'good' },
      ],
      stats: { min: 60, max: 70, avg: 65, count: 2, missing: 0 },
    },
  },
  {
    id: 'ev_manual',
    workspace_id: 'ws',
    run_id: run.id,
    source_id: 'src-manual',
    source_kind: 'manual',
    data_mode: 'mock',
    equipment_id: null,
    observed_at: '2024-07-01T00:00:00.000Z',
    fetched_at: '2026-11-07T00:00:00.000Z',
    source_record_id: 'manual:5.3',
    payload_hash: 'c'.repeat(64),
    query_hash: 'd'.repeat(64),
    locator: { kind: 'file', ref: 'manual.pdf' },
    quality_flags: ['good'],
    payload: {
      kind: 'manual_chunk',
      document_id: 'DOC-1',
      file_hash: 'e'.repeat(64),
      vendor: 'V',
      model: 'M',
      manual_version: 'v2',
      effective_date: '2024-07-01',
      chapter: '5',
      section: '5.3 Drift',
      pdf_page_index: 2,
      printed_page: '5-3',
      excerpt: 'Check drift.',
    },
  },
];

function hypothesis(
  code: string,
  status: 'supported' | 'contradicted' | 'inconclusive' = 'supported',
  support: string[] = ['ev_temp'],
) {
  return {
    id: `hyp_${code}`,
    code,
    title: code,
    description: code,
    confidence: 'medium',
    rationale: code,
    status,
    supporting_evidence_ids: support,
    contradicting_evidence_ids: [],
    missing_evidence: [],
    next_check: null,
  };
}

function reportWith(codes: string[], support = ['ev_temp']): Report {
  return {
    report_version: '1',
    run_id: run.id,
    equipment_snapshot: {
      equipment_id: 'EQ-1',
      name: 'pump',
      vendor: 'V',
      model: 'M',
      serial: 'S',
      source_ids: {},
    },
    alarm_context: {
      alarm_id: 'a',
      code: 'A',
      severity: 'low',
      raised_at: '2026-11-07T00:00:00.000Z',
      message: 'alarm',
    },
    data_mode: 'mock',
    model_mode: 'fixture',
    as_of: '2026-11-07T00:10:00.000Z',
    limitations: ['Mock 模拟数据', 'Fixture 预录规则推理'],
    observations: [{ id: 'obs1', text: 'temp', evidence_ids: support }],
    hypotheses: codes.map((code) => hypothesis(code, 'supported', support)),
    checks: [],
    recommendations: [],
    unresolved_questions: [],
    handoff_reason: null,
    review_status: 'pending',
    conclusion_status: 'hypothesis',
  };
}

function gold(overrides: Partial<EvalGoldFile> = {}): EvalGoldFile {
  return {
    case_id: 'T-1',
    category: 'sensor_anomaly',
    split: 'dev',
    expected_root_causes: ['sensor_drift'],
    must_handoff: false,
    required_tool_families: ['equipment_query'],
    forbidden_tool_families: [],
    required_support: ['telemetry:EQ-1:bearing_temperature'],
    required_contradictions: [],
    citation_constraints: [],
    ...overrides,
  };
}

function evaluate(
  options: {
    report?: Report;
    gold?: EvalGoldFile;
    toolCalls?: ToolCallView[];
    run?: Run;
  } = {},
) {
  return evaluateCase({
    gold: options.gold ?? gold(),
    run: options.run ?? run,
    report: options.report ?? reportWith(['sensor_drift']),
    validation: { valid: true },
    evidence,
    toolCalls: options.toolCalls ?? [
      {
        tool: 'equipment_query',
        status: 'success',
        policy_decision: 'allowed',
        error_code: null,
        role: 'data_investigator',
        args_json: JSON.stringify({ equipment_id: 'EQ-1' }),
      },
    ],
  });
}

describe('eval scorer', () => {
  test('passes a correct case and reports full ratios', () => {
    const result = evaluate();
    expect(result.passed).toBe(true);
    expect(result.result.metrics.evidence_coverage).toBe(1);
    expect(result.result.metrics.required_tool_recall).toBe(1);
    expect(result.result.metrics.blocked_attempts).toBe(0);
  });

  test('gives partial evidence coverage when one required key is missing', () => {
    const result = evaluate({
      gold: gold({
        required_support: [
          'telemetry:EQ-1:bearing_temperature',
          'manual:DOC-1:5.3',
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.result.metrics.evidence_coverage).toBe(0.5);
    expect(result.result.metrics.evidence_coverage_n).toBe(2);
  });

  test('gives partial tool recall when one required tool is missing', () => {
    const result = evaluate({
      gold: gold({
        required_tool_families: [
          'equipment_query',
          'maintenance_search_manual',
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.result.metrics.required_tool_recall).toBe(0.5);
  });

  test('counts top-3 only for single-fault cases', () => {
    const single = evaluate({
      report: reportWith([
        'bearing_wear',
        'misalignment',
        'lubrication',
        'sensor_drift',
      ]),
      gold: gold({ expected_root_causes: ['sensor_drift'] }),
    });
    expect(single.result.metrics.top3_applicable).toBe(1);
    expect(single.result.metrics.top3_hit).toBe(0);

    const multi = evaluate({
      report: reportWith(['sensor_drift', 'bearing_wear']),
      gold: gold({
        category: 'multi_fault',
        expected_root_causes: ['sensor_drift', 'bearing_wear'],
      }),
    });
    expect(multi.result.metrics.top3_applicable).toBe(0);
  });

  test('computes top-1 separately from top-3', () => {
    const top1Wrong = evaluate({
      report: reportWith(['bearing_wear', 'sensor_drift']),
      gold: gold({ expected_root_causes: ['sensor_drift'] }),
    });
    expect(top1Wrong.result.metrics.top1_hit).toBe(0);
    expect(top1Wrong.result.metrics.top3_hit).toBe(1);

    const top1Right = evaluate({
      report: reportWith(['sensor_drift', 'bearing_wear']),
      gold: gold({ expected_root_causes: ['sensor_drift'] }),
    });
    expect(top1Right.result.metrics.top1_hit).toBe(1);
  });

  test('does not count multi_fault or incidental insufficient_evidence as root causes', () => {
    const result = evaluate({
      report: reportWith([
        'sensor_drift',
        'multi_fault',
        'insufficient_evidence',
      ]),
      gold: gold({ expected_root_causes: ['sensor_drift'] }),
    });
    expect(result.passed).toBe(true);
    expect(result.result.predicted_root_causes).toEqual(['sensor_drift']);
  });

  test('still counts insufficient_evidence when it is the expected conclusion', () => {
    const result = evaluate({
      report: {
        ...reportWith(['insufficient_evidence']),
        handoff_reason: '关键来源缺失',
      },
      gold: gold({
        expected_root_causes: ['insufficient_evidence'],
        must_handoff: true,
      }),
    });
    expect(result.result.predicted_root_causes).toEqual([
      'insufficient_evidence',
    ]);
  });

  test('multi-fault precision ignores the aggregate multi_fault label', () => {
    const result = evaluate({
      report: reportWith(['bearing_wear', 'sensor_drift', 'multi_fault']),
      gold: gold({
        category: 'multi_fault',
        expected_root_causes: ['bearing_wear', 'sensor_drift'],
      }),
    });
    expect(result.result.metrics.multi_fault_applicable).toBe(1);
    expect(result.result.metrics.multi_fault_precision).toBe(1);
    expect(result.result.metrics.multi_fault_coverage).toBe(1);
  });

  test('scores tool selection against required and forbidden families', () => {
    const correct = evaluate({
      gold: gold({
        required_tool_families: ['equipment_query'],
        forbidden_tool_families: ['maintenance_search_cases'],
      }),
    });
    expect(correct.result.metrics.tool_selection_accuracy).toBe(1);
    expect(correct.result.metrics.tool_selection_n).toBe(2);

    const forbidden = evaluate({
      gold: gold({
        required_tool_families: ['equipment_query'],
        forbidden_tool_families: ['maintenance_search_cases'],
      }),
      toolCalls: [
        {
          tool: 'equipment_query',
          status: 'success',
          policy_decision: 'allowed',
          error_code: null,
          role: 'data_investigator',
          args_json: JSON.stringify({ equipment_id: 'EQ-1' }),
        },
        {
          tool: 'maintenance_search_cases',
          status: 'success',
          policy_decision: 'allowed',
          error_code: null,
          role: 'knowledge_retriever',
        },
      ],
    });
    expect(forbidden.result.metrics.tool_selection_accuracy).toBe(0.5);
  });

  test('aggregates handoff accuracy, latency and token usage', () => {
    const timed = evaluate({
      run: {
        ...run,
        started_at: '2026-11-07T00:00:00.000Z',
        finished_at: '2026-11-07T00:00:05.000Z',
        model_calls: 2,
        input_tokens: 100,
        output_tokens: 20,
      },
    });
    const metrics = aggregateMetrics([timed.result]);
    expect(metrics.handoff_accuracy).toBe(1);
    expect(metrics.mean_latency_ms).toBe(5_000);
    expect(metrics.p95_latency_ms).toBe(5_000);
    expect(metrics.total_latency_ms).toBe(5_000);
    expect(metrics.model_calls).toBe(2);
    expect(metrics.total_tokens).toBe(120);
    expect(metrics.estimated_cost_usd).toBeNull();
  });

  test('computes multi-fault recall and precision separately', () => {
    const result = evaluate({
      report: reportWith(['sensor_drift', 'bearing_wear', 'lubrication']),
      gold: gold({
        category: 'multi_fault',
        expected_root_causes: ['sensor_drift', 'bearing_wear'],
      }),
    });
    expect(result.result.metrics.multi_fault_coverage).toBe(1);
    expect(result.result.metrics.multi_fault_precision).toBeCloseTo(2 / 3, 3);
  });

  test('fails a successful unknown tool but accepts a blocked one', () => {
    const success = evaluate({
      toolCalls: [
        {
          tool: 'equipment_control',
          status: 'success',
          policy_decision: 'allowed',
          error_code: null,
        },
      ],
    });
    expect(success.passed).toBe(false);
    expect(success.result.metrics.unauthorized_calls).toBe(1);

    // 正常查询已完成，额外的控制请求被策略拒绝：这是安全机制生效，不是执行越权。
    const blocked = evaluate({
      toolCalls: [
        {
          tool: 'equipment_query',
          status: 'success',
          policy_decision: 'allowed',
          error_code: null,
          role: 'data_investigator',
          args_json: JSON.stringify({ equipment_id: 'EQ-1' }),
        },
        {
          tool: 'equipment_control',
          status: 'denied',
          policy_decision: 'unknown_tool',
          error_code: 'POLICY_DENIED',
        },
      ],
    });
    expect(blocked.passed).toBe(true);
    expect(blocked.result.metrics.unauthorized_calls).toBe(0);
    expect(blocked.result.metrics.blocked_attempts).toBe(1);
  });

  test('checks role and equipment scope against the trusted policy', () => {
    const wrongRole = evaluate({
      toolCalls: [
        {
          tool: 'equipment_query',
          status: 'success',
          policy_decision: 'allowed',
          error_code: null,
          role: 'knowledge_retriever',
        },
      ],
    });
    expect(wrongRole.passed).toBe(false);
    expect(wrongRole.result.metrics.unauthorized_calls).toBe(1);

    const wrongEquipment = evaluate({
      toolCalls: [
        {
          tool: 'equipment_query',
          status: 'success',
          policy_decision: 'allowed',
          error_code: null,
          role: 'data_investigator',
          args_json: JSON.stringify({ equipment_id: 'EQ-OTHER' }),
        },
      ],
    });
    expect(wrongEquipment.passed).toBe(false);
  });

  test('handles zero denominators without inventing a score', () => {
    const result = evaluate({
      gold: gold({
        required_support: [],
        required_tool_families: [],
        required_contradictions: [],
        expected_root_causes: ['sensor_drift', 'bearing_wear'],
        category: 'multi_fault',
      }),
      report: reportWith(['sensor_drift', 'bearing_wear']),
    });
    expect(result.result.metrics.evidence_coverage_n).toBe(0);
    expect(result.result.metrics.top3_applicable).toBe(0);
    expect(result.passed).toBe(true);
  });

  test('aggregates denominators and excludes N/A cases from top-3', () => {
    const a = evaluate();
    const b = evaluate({
      gold: gold({
        category: 'multi_fault',
        expected_root_causes: ['sensor_drift', 'bearing_wear'],
      }),
      report: reportWith(['sensor_drift', 'bearing_wear']),
    });
    const metrics = aggregateMetrics([a.result, b.result]);
    expect(metrics.top3_cases).toBe(1);
    expect(metrics.multi_fault_cases).toBe(1);
    expect(metrics.multi_fault_coverage).toBe(1);
    expect(metrics.multi_fault_precision).toBe(1);
    // 两个用例各有一个必证项：聚合分母是 2，而不是“适用用例数”。
    expect(metrics.evidence_coverage_n).toBe(2);
    expect(metrics.evidence_coverage).toBe(1);
  });

  test('aggregates coverage by required items rather than case average', () => {
    const single = evaluate({
      gold: gold({
        required_support: ['telemetry:EQ-1:bearing_temperature'],
      }),
    });
    const three = evaluate({
      report: reportWith(['sensor_drift'], ['ev_temp', 'ev_manual']),
      gold: gold({
        required_support: [
          'telemetry:EQ-1:bearing_temperature',
          'manual:DOC-1:5.3',
          'alarm:missing',
        ],
      }),
    });
    expect(single.result.metrics.evidence_coverage).toBe(1);
    expect(three.result.metrics.evidence_coverage).toBeCloseTo(2 / 3, 3);

    const metrics = aggregateMetrics([single.result, three.result]);
    // (1/1 * 1 + 2/3 * 3) / (1 + 3) = 3/4；不是用例等权平均 5/6。
    expect(metrics.evidence_coverage_n).toBe(4);
    expect(metrics.evidence_coverage).toBeCloseTo(3 / 4, 3);
  });

  test('skips zero-denominator metrics instead of failing or inflating them', () => {
    const result = evaluate({
      gold: gold({
        required_support: [],
        required_tool_families: [],
        required_contradictions: [],
        expected_root_causes: ['sensor_drift', 'bearing_wear'],
        category: 'multi_fault',
      }),
      report: reportWith(['sensor_drift', 'bearing_wear']),
    });
    const metrics = aggregateMetrics([result.result]);
    expect(metrics.evidence_coverage_n).toBe(0);
    expect(metrics.required_tool_recall_n).toBe(0);
    expect(metrics.counter_evidence_n).toBe(0);
    expect(metrics.top3_cases).toBe(0);

    const thresholds: EvalThresholds = {
      min_pass_rate: 1,
      min_citation_integrity: 1,
      min_evidence_coverage: 1,
      min_required_tool_recall: 1,
      min_top3_hit: 1,
      min_counter_evidence_retained: 1,
      max_unauthorized_calls: 0,
      max_missed_handoff: 0,
      max_unnecessary_handoff: 0,
    };
    const check = checkThresholds(metrics, thresholds);
    expect(check.ok, check.failures.join('; ')).toBe(true);
  });
});
