import {
  type AlarmContext,
  type EquipmentSnapshot,
  type Evidence,
  type Hypothesis,
  type Report,
  type Run,
} from './contracts/domain.js';
import { canonicalJson, sha256 } from './util.js';

export interface ManualDocumentView {
  document_id: string;
  model: string;
  manual_version: string;
  effective_date: string | null;
  withdrawn: boolean;
}

function sameStringSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) if (!setB.has(item)) return false;
  return true;
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  evidence_id?: string;
  hypothesis_id?: string;
}

export interface ReportValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function issue(
  severity: 'error' | 'warning',
  code: string,
  message: string,
  extra: { evidence_id?: string; hypothesis_id?: string } = {},
): ValidationIssue {
  return { severity, code, message, ...extra };
}

function withinWindow(
  timestamp: string | null,
  run: Run,
  toleranceMs = 5 * 60_000,
): boolean {
  if (!timestamp) return true;
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return false;
  return (
    value >= Date.parse(run.window.start) - toleranceMs &&
    value <= Date.parse(run.window.end) + toleranceMs
  );
}

export function validateReport(input: {
  report: Report;
  run: Run;
  equipment: EquipmentSnapshot;
  alarm: AlarmContext | null;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  /** 当前 Workspace 的手册目录；用于校验版本、适用期与撤版状态。 */
  documents: ManualDocumentView[];
  toolCalls: Array<{
    tool: string;
    status: string;
    policy_decision: string;
    error_code: string | null;
  }>;
}): ReportValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const { report, run, equipment, alarm, evidence, hypotheses } = input;
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const hypothesisById = new Map(hypotheses.map((item) => [item.id, item]));

  if (report.run_id !== run.id) {
    errors.push(
      issue(
        'error',
        'RUN_ID_MISMATCH',
        `报告 run_id ${report.run_id} 与当前 Run 不一致`,
      ),
    );
  }
  if (report.equipment_snapshot.equipment_id !== equipment.equipment_id) {
    errors.push(
      issue('error', 'EQUIPMENT_MISMATCH', '报告设备快照与 Run 设备不一致'),
    );
  }
  if (
    report.equipment_snapshot.model !== equipment.model ||
    report.equipment_snapshot.vendor !== equipment.vendor
  ) {
    errors.push(
      issue(
        'error',
        'EQUIPMENT_MODEL_MISMATCH',
        '报告设备型号/厂商与 Run 不一致',
      ),
    );
  }
  if (report.data_mode !== run.data_mode) {
    errors.push(
      issue('error', 'DATA_MODE_MISMATCH', '报告数据模式与 Run 不一致'),
    );
  }
  if (report.model_mode !== run.model_mode) {
    errors.push(
      issue('error', 'MODEL_MODE_MISMATCH', '报告模型模式与 Run 不一致'),
    );
  }
  if (run.alarm_id) {
    if (!alarm || report.alarm_context.alarm_id !== alarm.alarm_id) {
      errors.push(
        issue('error', 'ALARM_MISMATCH', '报告报警上下文与 Run 不一致'),
      );
    } else if (
      report.alarm_context.code !== alarm.code ||
      report.alarm_context.raised_at !== alarm.raised_at
    ) {
      warnings.push(
        issue(
          'warning',
          'ALARM_CONTEXT_DRIFT',
          '报告报警字段与入库报警存在差异',
        ),
      );
    }
  }
  const asOf = Date.parse(report.as_of);
  if (!Number.isFinite(asOf) || asOf > Date.now() + 5 * 60_000) {
    errors.push(
      issue('error', 'AS_OF_INVALID', '报告 as_of 不是有效的当前时间'),
    );
  }

  const cited = new Set<string>();
  const addCitation = (
    id: string,
    context: string,
    hypothesisId?: string,
  ): void => {
    cited.add(id);
    const item = evidenceById.get(id);
    if (!item) {
      errors.push(
        issue(
          'error',
          'CITATION_MISSING',
          `${context} 引用了不存在的证据 ${id}`,
          {
            evidence_id: id,
            hypothesis_id: hypothesisId,
          },
        ),
      );
      return;
    }
    if (item.run_id !== run.id || item.workspace_id !== run.workspace_id) {
      errors.push(
        issue(
          'error',
          'CITATION_SCOPE',
          `${context} 引用了其他 Run/Workspace 的证据 ${id}`,
          {
            evidence_id: id,
            hypothesis_id: hypothesisId,
          },
        ),
      );
    }
    if (item.equipment_id && item.equipment_id !== run.equipment_id) {
      errors.push(
        issue(
          'error',
          'CITATION_EQUIPMENT',
          `${context} 引用了其他设备的证据 ${id}`,
          {
            evidence_id: id,
            hypothesis_id: hypothesisId,
          },
        ),
      );
    }
    const payloadHash = sha256(canonicalJson(item.payload));
    if (payloadHash !== item.payload_hash) {
      errors.push(
        issue('error', 'CITATION_HASH', `证据 ${id} 的 payload hash 不一致`, {
          evidence_id: id,
        }),
      );
    }
    const p = item.payload;
    if (p.kind === 'manual_chunk') {
      if (p.model !== equipment.model) {
        errors.push(
          issue(
            'error',
            'MANUAL_MODEL_MISMATCH',
            `${context} 引用了机型 ${p.model} 的手册，当前设备为 ${equipment.model}`,
            { evidence_id: id, hypothesis_id: hypothesisId },
          ),
        );
      }
      // 版本适用性来自设备台账登记，而不是按演示机型硬编码。
      if (!equipment.manual_document_id || !equipment.manual_version) {
        errors.push(
          issue(
            'error',
            'MANUAL_REGISTRATION_MISSING',
            `${context} 引用了手册，但设备 ${equipment.equipment_id} 未登记适用手册与版本`,
            { evidence_id: id, hypothesis_id: hypothesisId },
          ),
        );
      } else {
        // 同一版本可以有原版、中文摘要等多个文档；关键约束是版本与机型，
        // 而不是强制只能引用登记的主文档 ID。
        if (p.manual_version !== equipment.manual_version) {
          errors.push(
            issue(
              'error',
              'MANUAL_VERSION_MISMATCH',
              `${context} 引用了手册版本 ${p.manual_version}，设备登记的适用版本为 ${equipment.manual_version}`,
              { evidence_id: id, hypothesis_id: hypothesisId },
            ),
          );
        }
      }
      const document = input.documents.find(
        (item) => item.document_id === p.document_id,
      );
      if (!document) {
        errors.push(
          issue(
            'error',
            'MANUAL_DOCUMENT_UNKNOWN',
            `${context} 引用了手册目录中不存在的文档 ${p.document_id}`,
            { evidence_id: id, hypothesis_id: hypothesisId },
          ),
        );
      }
      if (document?.withdrawn) {
        errors.push(
          issue(
            'error',
            'MANUAL_DOCUMENT_WITHDRAWN',
            `${context} 引用了已撤版手册 ${p.document_id}`,
            { evidence_id: id, hypothesis_id: hypothesisId },
          ),
        );
      }
      if (document && document.manual_version !== p.manual_version) {
        errors.push(
          issue(
            'error',
            'MANUAL_VERSION_DRIFT',
            `${context} 的证据版本 ${p.manual_version} 与手册目录 ${document.manual_version} 不一致`,
            { evidence_id: id, hypothesis_id: hypothesisId },
          ),
        );
      }
      if (p.effective_date && Date.parse(p.effective_date) > asOf) {
        errors.push(
          issue(
            'error',
            'MANUAL_NOT_EFFECTIVE',
            `${context} 引用的手册生效日期 ${p.effective_date} 晚于报告时间`,
            { evidence_id: id, hypothesis_id: hypothesisId },
          ),
        );
      }
    }
    if (p.kind === 'case_record' && p.equipment_model !== equipment.model) {
      errors.push(
        issue(
          'error',
          'CASE_MODEL_MISMATCH',
          `${context} 引用了机型 ${p.equipment_model} 的历史案例`,
          { evidence_id: id, hypothesis_id: hypothesisId },
        ),
      );
    }
    if (p.kind === 'alarm') {
      if (!withinWindow(item.observed_at, run, 2 * 60 * 60_000)) {
        warnings.push(
          issue(
            'warning',
            'ALARM_OUTSIDE_WINDOW',
            `报警证据 ${id} 的时间超出 Run 时间窗，需确认时间戳可信`,
            { evidence_id: id },
          ),
        );
      }
    } else if (
      p.kind === 'telemetry_series' ||
      p.kind === 'telemetry_point' ||
      p.kind === 'status_snapshot'
    ) {
      if (!withinWindow(item.observed_at, run)) {
        errors.push(
          issue(
            'error',
            'EVIDENCE_OUTSIDE_WINDOW',
            `遥测证据 ${id} 的时间超出 Run 时间窗`,
            { evidence_id: id },
          ),
        );
      }
      if (p.kind === 'telemetry_series') {
        const first = p.points[0]?.t;
        const last = p.points[p.points.length - 1]?.t;
        if (
          (first && !withinWindow(first, run, 10 * 60_000)) ||
          (last && !withinWindow(last, run, 10 * 60_000))
        ) {
          errors.push(
            issue(
              'error',
              'SERIES_OUTSIDE_WINDOW',
              `遥测序列 ${id} 的采样区间超出 Run 时间窗`,
              { evidence_id: id },
            ),
          );
        }
      }
    } else if (p.kind === 'mes_event' || p.kind === 'work_order') {
      if (!withinWindow(item.observed_at, run, 2 * 60 * 60_000)) {
        warnings.push(
          issue(
            'warning',
            'CONTEXT_OUTSIDE_WINDOW',
            `上下文证据 ${id} 的时间超出 Run 时间窗`,
            { evidence_id: id },
          ),
        );
      }
    }
  };

  for (const observation of report.observations) {
    if (observation.evidence_ids.length === 0) {
      errors.push(
        issue(
          'error',
          'OBSERVATION_WITHOUT_CITATION',
          `观察 ${observation.id} 没有引用证据`,
        ),
      );
    }
    for (const id of observation.evidence_ids) {
      addCitation(id, `观察 ${observation.id}`);
    }
  }

  if (report.hypotheses.length === 0) {
    errors.push(issue('error', 'NO_HYPOTHESES', '报告没有任何候选假设'));
  }
  for (const hypothesis of report.hypotheses) {
    const source = hypothesisById.get(hypothesis.id);
    if (!source) {
      errors.push(
        issue(
          'error',
          'HYPOTHESIS_UNKNOWN',
          `报告假设 ${hypothesis.id} 不在本 Run 的假设库中`,
          { hypothesis_id: hypothesis.id },
        ),
      );
    } else if (source.code !== hypothesis.code) {
      errors.push(
        issue(
          'error',
          'HYPOTHESIS_CODE_DRIFT',
          `报告假设 ${hypothesis.id} 的根因码被改写`,
          { hypothesis_id: hypothesis.id },
        ),
      );
    } else {
      // 报告只能复述已验证的假设状态与证据，不能自行把 proposed 升级为 supported。
      if (source.status !== hypothesis.status) {
        errors.push(
          issue(
            'error',
            'HYPOTHESIS_STATUS_DRIFT',
            `报告假设 ${hypothesis.code} 状态 ${hypothesis.status} 与已验证状态 ${source.status} 不一致`,
            { hypothesis_id: hypothesis.id },
          ),
        );
      }
      if (
        !sameStringSet(
          source.supporting_evidence_ids,
          hypothesis.supporting_evidence_ids,
        )
      ) {
        errors.push(
          issue(
            'error',
            'HYPOTHESIS_SUPPORT_DRIFT',
            `报告假设 ${hypothesis.code} 的支持证据与已验证假设不一致`,
            { hypothesis_id: hypothesis.id },
          ),
        );
      }
      if (
        !sameStringSet(
          source.contradicting_evidence_ids,
          hypothesis.contradicting_evidence_ids,
        )
      ) {
        errors.push(
          issue(
            'error',
            'HYPOTHESIS_CONTRADICTION_DRIFT',
            `报告假设 ${hypothesis.code} 的反证与已验证假设不一致`,
            { hypothesis_id: hypothesis.id },
          ),
        );
      }
    }
    for (const id of hypothesis.supporting_evidence_ids) {
      addCitation(id, `假设 ${hypothesis.code} 支持证据`, hypothesis.id);
    }
    for (const id of hypothesis.contradicting_evidence_ids) {
      addCitation(id, `假设 ${hypothesis.code} 反证`, hypothesis.id);
    }
    if (
      hypothesis.status === 'supported' &&
      hypothesis.supporting_evidence_ids.length === 0 &&
      hypothesis.code !== 'insufficient_evidence'
    ) {
      errors.push(
        issue(
          'error',
          'SUPPORTED_WITHOUT_EVIDENCE',
          `假设 ${hypothesis.code} 标记为 supported 但没有支持证据`,
          { hypothesis_id: hypothesis.id },
        ),
      );
    }
    if (
      hypothesis.status === 'supported' &&
      hypothesis.contradicting_evidence_ids.length > 0
    ) {
      errors.push(
        issue(
          'error',
          'SUPPORTED_WITH_CONTRADICTION',
          `假设 ${hypothesis.code} 仍有未处理的反证，不能标记 supported`,
          { hypothesis_id: hypothesis.id },
        ),
      );
    }
    if (
      hypothesis.code === 'multi_fault' &&
      hypothesis.status === 'supported'
    ) {
      errors.push(
        issue(
          'error',
          'MULTI_FAULT_PLACEHOLDER',
          `假设 ${hypothesis.id} 用 multi_fault 代替具体根因；多故障必须分别列出具体根因码`,
          { hypothesis_id: hypothesis.id },
        ),
      );
    }
    if (
      hypothesis.status === 'contradicted' &&
      hypothesis.contradicting_evidence_ids.length === 0
    ) {
      errors.push(
        issue(
          'error',
          'CONTRADICTED_WITHOUT_EVIDENCE',
          `假设 ${hypothesis.code} 标记为 contradicted 但没有反证`,
          { hypothesis_id: hypothesis.id },
        ),
      );
    }
  }

  for (const check of report.checks) {
    if (check.steps.length === 0) {
      errors.push(
        issue('error', 'CHECK_WITHOUT_STEPS', `检查 ${check.id} 没有步骤`),
      );
    }
    if (
      (check.kind ?? 'diagnostic') === 'diagnostic' &&
      check.evidence_ids.length === 0
    ) {
      errors.push(
        issue(
          'error',
          'CHECK_WITHOUT_CITATION',
          `诊断检查 ${check.id} 没有引用任何适用证据；通用安全提醒请标记 kind=safety`,
        ),
      );
    }
    if (check.risk !== 'low' && !check.requires_human) {
      errors.push(
        issue(
          'error',
          'CHECK_REQUIRES_HUMAN',
          `检查 ${check.id} 风险为 ${check.risk}，必须要求人工执行`,
        ),
      );
    }
    for (const id of check.evidence_ids) addCitation(id, `检查 ${check.id}`);
  }

  for (const recommendation of report.recommendations) {
    if (recommendation.control_execution !== 'disabled') {
      errors.push(
        issue(
          'error',
          'CONTROL_EXECUTION_ENABLED',
          `建议 ${recommendation.id} 试图启用控制执行`,
        ),
      );
    }
    if (
      (recommendation.kind ?? 'repair') === 'repair' &&
      recommendation.evidence_ids.length === 0
    ) {
      errors.push(
        issue(
          'error',
          'RECOMMENDATION_WITHOUT_CITATION',
          `维修建议 ${recommendation.id} 没有引用任何适用证据；通用安全提醒请标记 kind=safety`,
        ),
      );
    }
    if (
      /复位|启动|停机|关闭|写入|下发|调整设定/.test(recommendation.text) &&
      !recommendation.requires_human
    ) {
      errors.push(
        issue(
          'error',
          'CONTROL_SUGGESTION_NOT_HUMAN',
          `建议 ${recommendation.id} 含控制动作但未要求人工确认`,
        ),
      );
    }
    for (const id of recommendation.evidence_ids) {
      addCitation(id, `建议 ${recommendation.id}`);
    }
  }

  const supported = report.hypotheses.filter(
    (hypothesis) => hypothesis.status === 'supported',
  );
  const definitive = supported.filter(
    (hypothesis) =>
      hypothesis.code !== 'insufficient_evidence' &&
      hypothesis.code !== 'unknown',
  );
  if (
    definitive.length > 0 &&
    (!equipment.manual_document_id || !equipment.manual_version)
  ) {
    errors.push(
      issue(
        'error',
        'MANUAL_REGISTRATION_MISSING',
        `设备 ${equipment.equipment_id} 未登记适用手册/版本，不能形成确定性维修结论`,
      ),
    );
  }
  if (definitive.length > 0) {
    const citedManual = [...cited]
      .map((id) => evidenceById.get(id))
      .filter((item) => item?.payload.kind === 'manual_chunk');
    if (citedManual.length === 0) {
      warnings.push(
        issue(
          'warning',
          'NO_MANUAL_CITATION',
          '确定结论没有引用手册条款，需确认判定依据',
        ),
      );
    }
  }
  const hasInsufficient = report.hypotheses.some(
    (hypothesis) => hypothesis.code === 'insufficient_evidence',
  );
  if (definitive.length === 0 && hasInsufficient) {
    if (!report.handoff_reason) {
      errors.push(
        issue(
          'error',
          'HANDOFF_REASON_MISSING',
          '没有确定性根因且存在 insufficient_evidence 假设时必须写明转人工原因',
        ),
      );
    }
    if (report.conclusion_status !== 'insufficient_evidence') {
      errors.push(
        issue(
          'error',
          'CONCLUSION_NOT_INSUFFICIENT',
          '没有确定性根因且存在 insufficient_evidence 假设时 conclusion_status 必须是 insufficient_evidence',
        ),
      );
    }
  }
  if (
    report.conclusion_status === 'insufficient_evidence' &&
    definitive.length > 0
  ) {
    errors.push(
      issue(
        'error',
        'CONCLUSION_SUPPORTED_CONFLICT',
        'conclusion_status 为 insufficient_evidence 时不能同时存在 supported 的确定性根因',
      ),
    );
  }
  if (
    report.handoff_reason &&
    report.conclusion_status === 'engineer_confirmed'
  ) {
    errors.push(
      issue(
        'error',
        'HANDOFF_CONFIRMED_CONFLICT',
        '已转人工的报告不能标记为工程师已确认',
      ),
    );
  }
  if (
    definitive.some((hypothesis) =>
      hypothesis.missing_evidence.some((item) =>
        /适用版本手册|与设备匹配的手册版本/.test(item),
      ),
    )
  ) {
    errors.push(
      issue(
        'error',
        'VERSION_GAP_NOT_HANDOFF',
        '手册版本缺口未解决时不能形成确定结论',
      ),
    );
  }
  if (
    report.data_mode === 'mock' &&
    !report.limitations.some((item) => /Mock|模拟/.test(item))
  ) {
    errors.push(
      issue(
        'error',
        'MOCK_DISCLAIMER_MISSING',
        'Mock 模式报告必须标明模拟数据',
      ),
    );
  }
  if (
    report.model_mode === 'fixture' &&
    !report.limitations.some((item) => /Fixture|预录|规则推理/.test(item))
  ) {
    errors.push(
      issue(
        'error',
        'FIXTURE_DISCLAIMER_MISSING',
        'Fixture 模式报告必须标明不是真实模型输出',
      ),
    );
  }
  const deniedControl = input.toolCalls.filter(
    (call) =>
      call.status === 'denied' &&
      (call.policy_decision === 'control_tool' ||
        call.error_code === 'CONTROL_EXECUTION_DISABLED'),
  );
  if (deniedControl.length > 0) {
    warnings.push(
      issue(
        'warning',
        'CONTROL_ATTEMPT_BLOCKED',
        `已拦截 ${deniedControl.length} 次控制类工具请求`,
      ),
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validationMessages(result: ReportValidationResult): string[] {
  return result.errors.map((item) => `[${item.code}] ${item.message}`);
}

export function validationSummary(result: ReportValidationResult): {
  valid: boolean;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
} {
  return {
    valid: result.valid,
    errors: result.errors.length,
    warnings: result.warnings.length,
    issues: [...result.errors, ...result.warnings],
  };
}
