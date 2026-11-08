import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  closeContext,
  createSeededContext,
  DEMO_SCENARIOS,
  runDemo,
  type TestContext,
} from './helpers.js';
import { validateReport } from '../../src/diagnosis/report-validator.js';
import { canonicalJson, sha256 } from '../../src/diagnosis/util.js';
import type {
  Evidence,
  Report,
  Run,
} from '../../src/diagnosis/contracts/domain.js';

let context: TestContext;
let run: Run;
let report: Report;
let evidence: Evidence[];
let hypotheses: ReturnType<TestContext['repo']['listHypotheses']>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validate(
  overrides: {
    report?: Report;
    evidence?: Evidence[];
    run?: Run;
    equipment?: Report['equipment_snapshot'];
    documents?: ReturnType<TestContext['repo']['listDocuments']>;
  } = {},
) {
  return validateReport({
    report: overrides.report ?? report,
    run: overrides.run ?? run,
    equipment: overrides.equipment ?? report.equipment_snapshot,
    alarm: (overrides.report ?? report).alarm_context,
    evidence: overrides.evidence ?? evidence,
    hypotheses,
    documents:
      overrides.documents ?? context.repo.listDocuments(run.workspace_id),
    toolCalls: context.repo.listToolCalls(run.id).map((call) => ({
      tool: call.tool,
      status: call.status,
      policy_decision: call.policy_decision,
      error_code: call.error_code,
    })),
  });
}

beforeAll(async () => {
  context = await createSeededContext('diagnosis-validator');
  run = await runDemo(context, DEMO_SCENARIOS[0]);
  report = context.repo.getReport(run.id)!.report;
  evidence = context.repo.listEvidence(run.id);
  hypotheses = context.repo.listHypotheses(run.id);
}, 120_000);

afterAll(() => {
  closeContext(context);
});

describe('report validator', () => {
  test('accepts the orchestrator report as a valid baseline', () => {
    const result = validate();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test('rejects missing and cross-scope citations', () => {
    const missing = clone(report);
    missing.observations[0].evidence_ids = ['ev_missing'];
    const missingResult = validate({ report: missing });
    expect(missingResult.valid).toBe(false);
    expect(missingResult.errors.map((item) => item.code)).toContain(
      'CITATION_MISSING',
    );

    const foreign = clone(evidence);
    const foreignReport = clone(report);
    const citedId = foreignReport.observations[0].evidence_ids[0];
    const target = foreign.find((item) => item.id === citedId);
    expect(target, citedId).toBeDefined();
    target!.run_id = 'run_other';
    const foreignResult = validate({
      report: foreignReport,
      evidence: foreign,
    });
    expect(foreignResult.valid).toBe(false);
    expect(foreignResult.errors.map((item) => item.code)).toContain(
      'CITATION_SCOPE',
    );
  });

  test('rejects an insufficient conclusion that still has a supported root cause', () => {
    const conflicting = clone(report);
    conflicting.conclusion_status = 'insufficient_evidence';
    conflicting.handoff_reason = '证据不足，转人工';
    const result = validate({ report: conflicting });
    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain(
      'CONCLUSION_SUPPORTED_CONFLICT',
    );
  });

  test('rejects supported hypotheses without support or with contradiction', () => {
    const noSupport = clone(report);
    const supported = noSupport.hypotheses.find(
      (item) => item.status === 'supported',
    )!;
    supported.supporting_evidence_ids = [];
    const noSupportResult = validate({ report: noSupport });
    expect(noSupportResult.errors.map((item) => item.code)).toContain(
      'SUPPORTED_WITHOUT_EVIDENCE',
    );

    const withContradiction = clone(report);
    const target = withContradiction.hypotheses.find(
      (item) => item.status === 'supported',
    )!;
    target.contradicting_evidence_ids = [
      report.observations[0].evidence_ids[0],
    ];
    const contradictionResult = validate({ report: withContradiction });
    expect(contradictionResult.errors.map((item) => item.code)).toContain(
      'SUPPORTED_WITH_CONTRADICTION',
    );
  });

  test('rejects multi_fault as a supported substitute for specific causes', () => {
    const placeholder = clone(report);
    const target = placeholder.hypotheses.find(
      (item) => item.status === 'supported',
    )!;
    target.code = 'multi_fault';
    const result = validate({ report: placeholder });
    expect(result.errors.map((item) => item.code)).toContain(
      'MULTI_FAULT_PLACEHOLDER',
    );
  });

  test('rejects control execution and missing mode disclaimers', () => {
    const control = clone(report);
    if (control.recommendations.length > 0) {
      control.recommendations[0].control_execution = 'enabled';
      const controlResult = validate({ report: control });
      expect(controlResult.errors.map((item) => item.code)).toContain(
        'CONTROL_EXECUTION_ENABLED',
      );
    }

    const disclaimer = clone(report);
    disclaimer.limitations = ['仅用于演示'];
    const disclaimerResult = validate({ report: disclaimer });
    expect(disclaimerResult.errors.map((item) => item.code)).toContain(
      'MOCK_DISCLAIMER_MISSING',
    );
    expect(disclaimerResult.errors.map((item) => item.code)).toContain(
      'FIXTURE_DISCLAIMER_MISSING',
    );
  });

  test('rejects equipment/model drift and future as_of', () => {
    const equipment = clone(report);
    equipment.equipment_snapshot.model = 'OTHER-MODEL';
    const equipmentResult = validate({
      report: equipment,
      equipment: report.equipment_snapshot,
    });
    expect(equipmentResult.errors.map((item) => item.code)).toContain(
      'EQUIPMENT_MODEL_MISMATCH',
    );

    const future = clone(report);
    future.as_of = new Date(Date.now() + 60 * 60_000).toISOString();
    const futureResult = validate({ report: future });
    expect(futureResult.errors.map((item) => item.code)).toContain(
      'AS_OF_INVALID',
    );
  });

  test('rejects manual citations for another equipment model', () => {
    const manualEvidence = clone(evidence);
    const manual = manualEvidence.find(
      (item) => item.payload.kind === 'manual_chunk',
    );
    expect(manual).toBeDefined();
    if (!manual || manual.payload.kind !== 'manual_chunk') return;
    manual.payload.model = 'NP-300';
    const manualReport = clone(report);
    manualReport.observations[0].evidence_ids = [manual.id];
    const result = validate({
      report: manualReport,
      evidence: manualEvidence,
    });
    expect(result.errors.map((item) => item.code)).toContain(
      'MANUAL_MODEL_MISMATCH',
    );
  });

  test('rejects diagnostic checks and repair recommendations without citations', () => {
    const uncited = clone(report);
    for (const item of [...uncited.checks, ...uncited.recommendations]) {
      item.evidence_ids = [];
    }
    const result = validate({ report: uncited });
    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain(
      'CHECK_WITHOUT_CITATION',
    );
    expect(result.errors.map((item) => item.code)).toContain(
      'RECOMMENDATION_WITHOUT_CITATION',
    );
  });

  test('allows uncited safety notes but still rejects uncited repair advice', () => {
    const safety = clone(report);
    for (const item of safety.checks) {
      item.kind = 'safety';
      item.evidence_ids = [];
    }
    for (const item of safety.recommendations) {
      item.kind = 'safety';
      item.evidence_ids = [];
    }
    expect(validate({ report: safety }).valid).toBe(true);

    const mixed = clone(safety);
    if (mixed.recommendations.length > 0) {
      mixed.recommendations[0].kind = 'repair';
      const result = validate({ report: mixed });
      expect(result.errors.map((item) => item.code)).toContain(
        'RECOMMENDATION_WITHOUT_CITATION',
      );
    }
  });

  test('rejects obsolete, withdrawn, unknown and future manual versions', () => {
    const manualEvidence = clone(evidence);
    const manual = manualEvidence.find(
      (item) => item.payload.kind === 'manual_chunk',
    );
    expect(manual).toBeDefined();
    if (!manual || manual.payload.kind !== 'manual_chunk') return;

    manual.payload.manual_version = 'OBSOLETE-v0';
    manual.payload_hash = sha256(canonicalJson(manual.payload));
    const obsolete = validate({ evidence: manualEvidence });
    expect(obsolete.valid).toBe(false);
    expect(obsolete.errors.map((item) => item.code)).toContain(
      'MANUAL_VERSION_MISMATCH',
    );

    const withdrawn = clone(context.repo.listDocuments(run.workspace_id)).map(
      (document) =>
        document.document_id === manual.payload.document_id
          ? { ...document, withdrawn: true }
          : document,
    );
    const withdrawnResult = validate({ documents: withdrawn });
    expect(withdrawnResult.errors.map((item) => item.code)).toContain(
      'MANUAL_DOCUMENT_WITHDRAWN',
    );

    const unknown = clone(report);
    unknown.equipment_snapshot.manual_document_id = null;
    unknown.equipment_snapshot.manual_version = null;
    const unknownResult = validate({
      report: unknown,
      equipment: unknown.equipment_snapshot,
    });
    expect(unknownResult.errors.map((item) => item.code)).toContain(
      'MANUAL_REGISTRATION_MISSING',
    );

    const futureEvidence = clone(evidence);
    const futureManual = futureEvidence.find(
      (item) => item.payload.kind === 'manual_chunk',
    );
    if (!futureManual || futureManual.payload.kind !== 'manual_chunk') return;
    futureManual.payload.effective_date = '2999-01-01';
    futureManual.payload_hash = sha256(canonicalJson(futureManual.payload));
    const futureResult = validate({ evidence: futureEvidence });
    expect(futureResult.errors.map((item) => item.code)).toContain(
      'MANUAL_NOT_EFFECTIVE',
    );
  });

  test('rejects report hypotheses that drift from verified state', () => {
    const statusDrift = clone(report);
    const supported = statusDrift.hypotheses.find(
      (item) => item.status === 'supported',
    )!;
    supported.status = 'proposed';
    const statusResult = validate({ report: statusDrift });
    expect(statusResult.errors.map((item) => item.code)).toContain(
      'HYPOTHESIS_STATUS_DRIFT',
    );

    const supportDrift = clone(report);
    const target = supportDrift.hypotheses.find(
      (item) => item.status === 'supported',
    )!;
    target.supporting_evidence_ids = target.supporting_evidence_ids.slice(1);
    const supportResult = validate({ report: supportDrift });
    expect(supportResult.errors.map((item) => item.code)).toContain(
      'HYPOTHESIS_SUPPORT_DRIFT',
    );
  });
});
