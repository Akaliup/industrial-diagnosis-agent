/**
 * 设备智诊领域协议 —— 唯一源文件。
 *
 * 该文件同时被主服务、MCP 子包和 Web 使用。请勿在其它位置手写第二套类型；
 * 修改后运行 `npm run diagnosis:sync-contracts` 生成副本并更新 hash 清单。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 基础标量
// ---------------------------------------------------------------------------

export const utcDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    '必须是 UTC ISO 8601 时间（以 Z 结尾）',
  );

export const DataModeSchema = z.enum(['mock', 'replay', 'live']);
export type DataMode = z.infer<typeof DataModeSchema>;

export const ModelModeSchema = z.enum(['fixture', 'live']);
export type ModelMode = z.infer<typeof ModelModeSchema>;

export const ToolStatusSchema = z.enum([
  'success',
  'partial',
  'no_data',
  'error',
]);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_human',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StageSchema = z.enum([
  'confirm_status',
  'locate_anomaly',
  'generate_hypotheses',
  'verify_evidence',
  'produce_report',
]);
export type Stage = z.infer<typeof StageSchema>;

export const ReviewStatusSchema = z.enum(['pending', 'accepted', 'rejected']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ConclusionStatusSchema = z.enum([
  'hypothesis',
  'insufficient_evidence',
  'engineer_confirmed',
]);
export type ConclusionStatus = z.infer<typeof ConclusionStatusSchema>;

export const HypothesisStatusSchema = z.enum([
  'proposed',
  'supported',
  'contradicted',
  'inconclusive',
]);
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;

export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const RoleSchema = z.enum([
  'data_investigator',
  'knowledge_retriever',
  'hypothesis_verifier',
  'report_reviewer',
]);
export type Role = z.infer<typeof RoleSchema>;

export const RiskLevelSchema = z.enum([
  'read',
  'knowledge_read',
  'control_intent',
  'control',
]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const SourceKindSchema = z.enum([
  'scada',
  'rootcloud',
  'mes',
  'work_order',
  'manual',
  'case',
  'alarm',
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const QualityFlagSchema = z.enum([
  'good',
  'missing',
  'interpolated',
  'out_of_order',
  'clock_skew',
  'unit_unknown',
  'stale',
  'low_quality',
]);
export type QualityFlag = z.infer<typeof QualityFlagSchema>;

export const ErrorCodeSchema = z.enum([
  'INVALID_ARGUMENT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'AMBIGUOUS_EQUIPMENT',
  'UNCONFIGURED',
  'TIMEOUT',
  'RATE_LIMITED',
  'SOURCE_UNAVAILABLE',
  'SCHEMA_MISMATCH',
  'STALE_DATA',
  'CANCELLED',
  'POLICY_DENIED',
  'BUDGET_EXCEEDED',
  'REPEATED_CALL',
  'CONTROL_EXECUTION_DISABLED',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const RootCauseCodeSchema = z.enum([
  'sensor_drift',
  'sensor_stuck',
  'sensor_range',
  'sampling_gap',
  'bearing_wear',
  'misalignment',
  'lubrication',
  'false_alarm_comm',
  'false_alarm_time',
  'false_alarm_threshold',
  'false_alarm_recovered',
  'multi_fault',
  'insufficient_evidence',
  'unknown',
]);
export type RootCauseCode = z.infer<typeof RootCauseCodeSchema>;

export const TOOL_NAMES = [
  'equipment_resolve',
  'equipment_query',
  'maintenance_search_manual',
  'maintenance_get_manual_section',
  'maintenance_search_cases',
  'evidence_get',
] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const QueryKindSchema = z.enum([
  'status',
  'telemetry',
  'alarms',
  'mes_events',
  'work_orders',
]);
export type QueryKind = z.infer<typeof QueryKindSchema>;

// ---------------------------------------------------------------------------
// 时间窗与查询参数
// ---------------------------------------------------------------------------

export const WindowSchema = z
  .object({
    start: utcDateTime,
    end: utcDateTime,
  })
  .refine((w) => Date.parse(w.start) < Date.parse(w.end), {
    message: 'window.start 必须早于 window.end',
    path: ['end'],
  })
  .refine(
    (w) => Date.parse(w.end) - Date.parse(w.start) <= 24 * 60 * 60 * 1000,
    { message: '单次查询窗口最多 24 小时', path: ['end'] },
  );
export type Window = z.infer<typeof WindowSchema>;

export const EquipmentResolveInputSchema = z
  .object({
    query: z.string().min(1).max(128),
    vendor: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(64).optional(),
  })
  .strict();
export type EquipmentResolveInput = z.infer<typeof EquipmentResolveInputSchema>;

export const EquipmentQueryInputSchema = z
  .object({
    equipment_id: z.string().min(1).max(64),
    query_kind: QueryKindSchema,
    alarm_code: z.string().min(1).max(64).optional(),
    window: WindowSchema,
    metrics: z.array(z.string().min(1).max(64)).max(16).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    cursor: z.string().max(256).optional(),
  })
  .strict();
export type EquipmentQueryInput = z.infer<typeof EquipmentQueryInputSchema>;

export const ManualSearchInputSchema = z
  .object({
    query: z.string().min(1).max(200),
    equipment_model: z.string().min(1).max(64).optional(),
    manual_version: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();
export type ManualSearchInput = z.infer<typeof ManualSearchInputSchema>;

export const ManualSectionInputSchema = z
  .object({
    document_id: z.string().min(1).max(64),
    chunk_id: z.string().min(1).max(64).optional(),
    page: z.number().int().min(1).max(5000).optional(),
  })
  .strict();
export type ManualSectionInput = z.infer<typeof ManualSectionInputSchema>;

export const CaseSearchInputSchema = z
  .object({
    query: z.string().min(1).max(200),
    equipment_model: z.string().min(1).max(64).optional(),
    asset_category: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();
export type CaseSearchInput = z.infer<typeof CaseSearchInputSchema>;

export const EvidenceGetInputSchema = z
  .object({
    evidence_ids: z.array(z.string().min(1).max(64)).min(1).max(50),
  })
  .strict();
export type EvidenceGetInput = z.infer<typeof EvidenceGetInputSchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EvidenceLocatorSchema = z
  .object({
    kind: z.enum(['db', 'file', 'url']),
    ref: z.string().min(1).max(512),
    page: z.number().int().min(1).optional(),
  })
  .strict();
export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

const telemetryPointPayload = z.object({
  kind: z.literal('telemetry_point'),
  metric: z.string(),
  value: z.number(),
  unit: z.string(),
  normalized_value: z.number().nullable(),
  normalized_unit: z.string().nullable(),
  quality: QualityFlagSchema,
});

const alarmPayload = z.object({
  kind: z.literal('alarm'),
  alarm_event_id: z.string(),
  code: z.string(),
  severity: z.string(),
  state: z.enum(['active', 'cleared', 'unknown']),
  raised_at: utcDateTime,
  cleared_at: utcDateTime.nullable(),
  message: z.string(),
});

const mesEventPayload = z.object({
  kind: z.literal('mes_event'),
  event_id: z.string(),
  event_type: z.string(),
  occurred_at: utcDateTime,
  summary: z.string(),
  work_order_id: z.string().nullable(),
});

const workOrderPayload = z.object({
  kind: z.literal('work_order'),
  work_order_id: z.string(),
  title: z.string(),
  status: z.string(),
  opened_at: utcDateTime,
  closed_at: utcDateTime.nullable(),
  root_cause_code: RootCauseCodeSchema.nullable(),
  summary: z.string(),
});

const manualChunkPayload = z.object({
  kind: z.literal('manual_chunk'),
  document_id: z.string(),
  file_hash: z.string(),
  vendor: z.string(),
  model: z.string(),
  manual_version: z.string(),
  effective_date: z.string().nullable(),
  chapter: z.string().nullable(),
  section: z.string().nullable(),
  pdf_page_index: z.number().int().min(1),
  printed_page: z.string().nullable(),
  excerpt: z.string(),
});

const caseRecordPayload = z.object({
  kind: z.literal('case_record'),
  case_id: z.string(),
  title: z.string(),
  equipment_model: z.string(),
  asset_category: z.string(),
  occurred_at: utcDateTime,
  root_cause_code: RootCauseCodeSchema,
  summary: z.string(),
});

const statusSnapshotPayload = z.object({
  kind: z.literal('status_snapshot'),
  equipment_id: z.string(),
  state: z.string(),
  mode: z.string().nullable(),
  last_seen: utcDateTime.nullable(),
  points: z.array(
    z.object({
      metric: z.string(),
      value: z.number(),
      unit: z.string(),
      at: utcDateTime,
      quality: QualityFlagSchema,
    }),
  ),
});

const telemetrySeriesPayload = z.object({
  kind: z.literal('telemetry_series'),
  equipment_id: z.string(),
  metric: z.string(),
  unit: z.string(),
  points: z.array(
    z.object({
      t: utcDateTime,
      v: z.number(),
      q: QualityFlagSchema,
    }),
  ),
  stats: z.object({
    min: z.number(),
    max: z.number(),
    avg: z.number(),
    count: z.number().int(),
    missing: z.number().int(),
  }),
});

export const EvidencePayloadSchema = z.discriminatedUnion('kind', [
  telemetryPointPayload,
  telemetrySeriesPayload,
  alarmPayload,
  mesEventPayload,
  workOrderPayload,
  manualChunkPayload,
  caseRecordPayload,
  statusSnapshotPayload,
]);
export type EvidencePayload = z.infer<typeof EvidencePayloadSchema>;

export const EvidenceSchema = z
  .object({
    id: z.string().min(1).max(64),
    workspace_id: z.string(),
    run_id: z.string(),
    source_id: z.string(),
    source_kind: SourceKindSchema,
    data_mode: DataModeSchema,
    equipment_id: z.string().nullable(),
    observed_at: utcDateTime.nullable(),
    fetched_at: utcDateTime,
    source_record_id: z.string(),
    payload_hash: z.string().length(64),
    query_hash: z.string().length(64),
    locator: EvidenceLocatorSchema,
    quality_flags: z.array(QualityFlagSchema),
    payload: EvidencePayloadSchema,
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

/** MCP 返回的取证草稿：id 由 MCP 服务端生成，主服务入库时重新绑定 Run 作用域。 */
export const EvidenceDraftSchema = EvidenceSchema;
export type EvidenceDraft = z.infer<typeof EvidenceDraftSchema>;

// ---------------------------------------------------------------------------
// 统一工具返回
// ---------------------------------------------------------------------------

export const CoverageSchema = z
  .object({
    from: utcDateTime,
    to: utcDateTime,
    complete: z.boolean(),
    missing: z.array(z.string()),
  })
  .strict();
export type Coverage = z.infer<typeof CoverageSchema>;

export const ToolWarningSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();
export type ToolWarning = z.infer<typeof ToolWarningSchema>;

export const ToolErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    retryable: z.boolean(),
    safe_message: z.string(),
  })
  .strict();
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const ToolResponseEnvelopeSchema = z
  .object({
    schema_version: z.literal('1'),
    request_id: z.string(),
    logical_call_id: z.string(),
    data_mode: DataModeSchema,
    status: ToolStatusSchema,
    data: z.unknown().nullable(),
    evidence: z.array(EvidenceDraftSchema),
    coverage: CoverageSchema,
    warnings: z.array(ToolWarningSchema),
    error: ToolErrorSchema.nullable(),
    next_cursor: z.string().nullable(),
  })
  .strict();
export type ToolResponseEnvelope = z.infer<typeof ToolResponseEnvelopeSchema>;

export type ToolResponse<T> = Omit<ToolResponseEnvelope, 'data'> & {
  data: T | null;
};

/** 适配器/知识服务内部使用的强类型结果；由网关统一包装成 ToolResponseEnvelope。 */
export interface ToolResult<T> {
  status: ToolStatus;
  data: T | null;
  evidence: EvidenceDraft[];
  coverage: Coverage;
  warnings: ToolWarning[];
  error: ToolError | null;
  next_cursor: string | null;
}

// 各 query_kind 的强类型 data
export const EquipmentStatusDataSchema = z.object({
  equipment_id: z.string(),
  state: z.string(),
  mode: z.string().nullable(),
  last_seen: utcDateTime.nullable(),
  points: z.array(
    z.object({
      metric: z.string(),
      value: z.number(),
      unit: z.string(),
      at: utcDateTime,
      quality: QualityFlagSchema,
    }),
  ),
});
export type EquipmentStatusData = z.infer<typeof EquipmentStatusDataSchema>;

export const TelemetryDataSchema = z.object({
  equipment_id: z.string(),
  series: z.array(
    z.object({
      metric: z.string(),
      unit: z.string(),
      points: z.array(
        z.object({
          t: utcDateTime,
          v: z.number(),
          q: QualityFlagSchema,
        }),
      ),
    }),
  ),
  stats: z.array(
    z.object({
      metric: z.string(),
      unit: z.string(),
      min: z.number(),
      max: z.number(),
      avg: z.number(),
      count: z.number().int(),
      missing: z.number().int(),
    }),
  ),
  truncated: z.boolean(),
});
export type TelemetryData = z.infer<typeof TelemetryDataSchema>;

export const AlarmsDataSchema = z.object({
  equipment_id: z.string(),
  alarms: z.array(
    z.object({
      alarm_event_id: z.string(),
      code: z.string(),
      severity: z.string(),
      state: z.enum(['active', 'cleared', 'unknown']),
      raised_at: utcDateTime,
      cleared_at: utcDateTime.nullable(),
      message: z.string(),
    }),
  ),
});
export type AlarmsData = z.infer<typeof AlarmsDataSchema>;

export const MesEventsDataSchema = z.object({
  equipment_id: z.string(),
  events: z.array(
    z.object({
      event_id: z.string(),
      event_type: z.string(),
      occurred_at: utcDateTime,
      summary: z.string(),
      work_order_id: z.string().nullable(),
    }),
  ),
});
export type MesEventsData = z.infer<typeof MesEventsDataSchema>;

export const WorkOrdersDataSchema = z.object({
  equipment_id: z.string(),
  orders: z.array(
    z.object({
      work_order_id: z.string(),
      title: z.string(),
      status: z.string(),
      opened_at: utcDateTime,
      closed_at: utcDateTime.nullable(),
      root_cause_code: RootCauseCodeSchema.nullable(),
      summary: z.string(),
    }),
  ),
});
export type WorkOrdersData = z.infer<typeof WorkOrdersDataSchema>;

export const EquipmentResolveDataSchema = z.object({
  matches: z.array(
    z.object({
      equipment_id: z.string(),
      name: z.string(),
      vendor: z.string(),
      model: z.string(),
      serial: z.string(),
      source_ids: z.record(z.string(), z.string()),
    }),
  ),
  ambiguous: z.boolean(),
});
export type EquipmentResolveData = z.infer<typeof EquipmentResolveDataSchema>;

export const ManualSearchDataSchema = z.object({
  hits: z.array(
    z.object({
      document_id: z.string(),
      chunk_id: z.string(),
      title: z.string(),
      vendor: z.string(),
      model: z.string(),
      manual_version: z.string(),
      effective_date: z.string().nullable(),
      page: z.number().int(),
      printed_page: z.string().nullable(),
      section: z.string().nullable(),
      excerpt: z.string(),
      score: z.number(),
      file_hash: z.string(),
    }),
  ),
});
export type ManualSearchData = z.infer<typeof ManualSearchDataSchema>;

export const ManualSectionDataSchema = z.object({
  document_id: z.string(),
  chunk_id: z.string(),
  title: z.string(),
  vendor: z.string(),
  model: z.string(),
  manual_version: z.string(),
  effective_date: z.string().nullable(),
  page: z.number().int(),
  printed_page: z.string().nullable(),
  section: z.string().nullable(),
  excerpt: z.string(),
  file_hash: z.string(),
});
export type ManualSectionData = z.infer<typeof ManualSectionDataSchema>;

export const CaseSearchDataSchema = z.object({
  hits: z.array(
    z.object({
      case_id: z.string(),
      title: z.string(),
      equipment_model: z.string(),
      asset_category: z.string(),
      occurred_at: utcDateTime,
      root_cause_code: RootCauseCodeSchema,
      summary: z.string(),
      similarity_note: z.string(),
    }),
  ),
});
export type CaseSearchData = z.infer<typeof CaseSearchDataSchema>;

export const EvidenceGetDataSchema = z.object({
  evidence: z.array(EvidenceSchema),
});
export type EvidenceGetData = z.infer<typeof EvidenceGetDataSchema>;

// ---------------------------------------------------------------------------
// 假设、报告、检查、建议
// ---------------------------------------------------------------------------

export const HypothesisDraftSchema = z
  .object({
    code: RootCauseCodeSchema,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(1200),
    confidence: ConfidenceSchema,
    status: HypothesisStatusSchema.optional(),
    rationale: z.string().min(1).max(1200),
    supporting_evidence_ids: z.array(z.string()).max(30),
    contradicting_evidence_ids: z.array(z.string()).max(30),
    missing_evidence: z.array(z.string()).max(10),
    next_check: z.string().max(300).nullable(),
    /** 模型对状态判断的补充说明；可选，不参与状态/证据一致性校验。 */
    status_note: z.string().max(300).optional(),
  })
  .strict();
export type HypothesisDraft = z.infer<typeof HypothesisDraftSchema>;

export const HypothesisSchema = HypothesisDraftSchema.extend({
  id: z.string(),
  status: HypothesisStatusSchema,
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const ObservationSchema = z
  .object({
    id: z.string(),
    text: z.string().min(1).max(800),
    evidence_ids: z.array(z.string()).min(1).max(20),
  })
  .strict();
export type Observation = z.infer<typeof ObservationSchema>;

export const CheckSchema = z
  .object({
    id: z.string(),
    /**
     * diagnostic: 依据本次证据的诊断检查，必须引用证据；
     * safety: 通用安全提醒/转人工步骤，允许不引用具体证据。
     */
    kind: z.enum(['diagnostic', 'safety']).default('diagnostic'),
    purpose: z.string().min(1).max(400),
    preconditions: z.array(z.string()).max(10),
    steps: z.array(z.string()).min(1).max(20),
    expected_observation: z.string().max(400),
    risk: z.enum(['low', 'medium', 'high']),
    role: z.string(),
    evidence_ids: z.array(z.string()).max(20),
    requires_human: z.boolean(),
  })
  .strict();
export type Check = z.infer<typeof CheckSchema>;

export const RecommendationSchema = z
  .object({
    id: z.string(),
    /** repair: 针对根因的维修建议，必须引用证据；safety: 通用安全提醒。 */
    kind: z.enum(['repair', 'safety']).default('repair'),
    text: z.string().min(1).max(800),
    evidence_ids: z.array(z.string()).max(20),
    conditions: z.array(z.string()).max(10),
    requires_human: z.boolean(),
    control_execution: z.literal('disabled'),
  })
  .strict();
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const EquipmentSnapshotSchema = z
  .object({
    equipment_id: z.string(),
    name: z.string(),
    vendor: z.string(),
    model: z.string(),
    serial: z.string(),
    /** 设备台账登记的适用手册；未知时不得形成确定性维修结论。 */
    manual_document_id: z.string().nullable().optional(),
    manual_version: z.string().nullable().optional(),
    source_ids: z.record(z.string(), z.string()),
  })
  .strict();
export type EquipmentSnapshot = z.infer<typeof EquipmentSnapshotSchema>;

export const AlarmContextSchema = z
  .object({
    alarm_id: z.string(),
    code: z.string(),
    severity: z.string(),
    raised_at: utcDateTime,
    message: z.string(),
  })
  .strict();
export type AlarmContext = z.infer<typeof AlarmContextSchema>;

export const ReportSchema = z
  .object({
    report_version: z.literal('1'),
    run_id: z.string(),
    equipment_snapshot: EquipmentSnapshotSchema,
    alarm_context: AlarmContextSchema,
    data_mode: DataModeSchema,
    model_mode: ModelModeSchema,
    as_of: utcDateTime,
    limitations: z.array(z.string()),
    observations: z.array(ObservationSchema).max(40),
    hypotheses: z.array(HypothesisSchema).max(5),
    checks: z.array(CheckSchema).max(12),
    recommendations: z.array(RecommendationSchema).max(12),
    unresolved_questions: z.array(z.string()).max(20),
    handoff_reason: z.string().nullable(),
    review_status: ReviewStatusSchema,
    conclusion_status: ConclusionStatusSchema,
  })
  .strict();
export type Report = z.infer<typeof ReportSchema>;

export const ReportDraftSchema = ReportSchema.omit({
  report_version: true,
  run_id: true,
  data_mode: true,
  model_mode: true,
  as_of: true,
  review_status: true,
  conclusion_status: true,
  equipment_snapshot: true,
  alarm_context: true,
});
export type ReportDraft = z.infer<typeof ReportDraftSchema>;

// ---------------------------------------------------------------------------
// 角色输出
// ---------------------------------------------------------------------------

export const QueryRequestSchema = z
  .object({
    tool: ToolNameSchema,
    args: z.record(z.string(), z.unknown()),
    target_hypothesis: z.string().max(64).nullable(),
    evidence_gap: z.string().min(1).max(300),
    expected_discrimination: z.string().min(1).max(300),
    rationale: z.string().min(1).max(500),
  })
  .strict();
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

export const DataInvestigatorOutputSchema = z
  .object({
    summary: z.string().max(1200),
    queries: z.array(QueryRequestSchema).max(8).default([]),
  })
  .strict();
export type DataInvestigatorOutput = z.infer<
  typeof DataInvestigatorOutputSchema
>;

export const KnowledgeRetrieverOutputSchema = z
  .object({
    summary: z.string().max(1200),
    queries: z.array(QueryRequestSchema).max(8).default([]),
  })
  .strict();
export type KnowledgeRetrieverOutput = z.infer<
  typeof KnowledgeRetrieverOutputSchema
>;

export const HypothesisVerifierOutputSchema = z
  .object({
    summary: z.string().max(2000),
    hypotheses: z.array(HypothesisDraftSchema).max(5),
    next_checks: z.array(QueryRequestSchema).max(6).default([]),
  })
  .strict();
export type HypothesisVerifierOutput = z.infer<
  typeof HypothesisVerifierOutputSchema
>;

export const ReportReviewerOutputSchema = z
  .object({
    summary: z.string().max(2000),
    report: ReportDraftSchema,
    review_notes: z.array(z.string()).max(20),
  })
  .strict();
export type ReportReviewerOutput = z.infer<typeof ReportReviewerOutputSchema>;

// ---------------------------------------------------------------------------
// Run、事件、预算
// ---------------------------------------------------------------------------

export const BudgetSnapshotSchema = z
  .object({
    max_rounds_total: z.number().int(),
    max_rounds_per_stage: z.number().int(),
    max_logical_tool_calls: z.number().int(),
    max_attempts_per_call: z.number().int(),
    max_concurrent_tools: z.number().int(),
    source_timeout_ms: z.number().int(),
    run_wall_clock_ms: z.number().int(),
    max_model_calls: z.number().int(),
    max_input_tokens: z.number().int(),
    max_output_tokens: z.number().int(),
    max_rounds_without_new_evidence: z.number().int(),
  })
  .strict();
export type BudgetSnapshot = z.infer<typeof BudgetSnapshotSchema>;

export const DEFAULT_BUDGET: BudgetSnapshot = {
  max_rounds_total: 8,
  max_rounds_per_stage: 3,
  max_logical_tool_calls: 32,
  max_attempts_per_call: 3,
  max_concurrent_tools: 4,
  source_timeout_ms: 10_000,
  run_wall_clock_ms: 300_000,
  max_model_calls: 16,
  max_input_tokens: 128_000,
  max_output_tokens: 12_000,
  max_rounds_without_new_evidence: 3,
};

export const RunSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    user_id: z.string(),
    status: RunStatusSchema,
    stage: StageSchema,
    alarm_id: z.string().nullable(),
    equipment_id: z.string(),
    window: WindowSchema,
    symptom: z.string().nullable(),
    data_mode: DataModeSchema,
    model_mode: ModelModeSchema,
    budget: BudgetSnapshotSchema,
    stage_rounds: z.record(z.string(), z.number().int()),
    total_rounds: z.number().int(),
    logical_calls: z.number().int(),
    model_calls: z.number().int(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    no_new_evidence_rounds: z.number().int(),
    checkpoint: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
    handoff_reason: z.string().nullable(),
    review_status: ReviewStatusSchema,
    conclusion_status: ConclusionStatusSchema,
    created_at: utcDateTime,
    started_at: utcDateTime.nullable(),
    finished_at: utcDateTime.nullable(),
    lease_owner: z.string().nullable(),
    lease_expires_at: utcDateTime.nullable(),
    lease_token: z.number().int().nonnegative(),
  })
  .strict();
export type Run = z.infer<typeof RunSchema>;

export const RunEventTypeSchema = z.enum([
  'run.created',
  'run.started',
  'stage.changed',
  'tool.started',
  'tool.finished',
  'evidence.added',
  'hypothesis.updated',
  'report.reconciled',
  'review.required',
  'report.ready',
  'run.failed',
  'run.cancelled',
  'run.awaiting_human',
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunEventSchema = z
  .object({
    event_id: z.string(),
    run_id: z.string(),
    seq: z.number().int().positive(),
    timestamp: utcDateTime,
    type: RunEventTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    schema_version: z.literal('1'),
  })
  .strict();
export type RunEvent = z.infer<typeof RunEventSchema>;

export const ContextManifestSchema = z
  .object({
    run_id: z.string(),
    role: z.string(),
    stage: StageSchema,
    included_evidence_ids: z.array(z.string()),
    dropped: z.array(z.object({ id: z.string(), reason: z.string() })),
    estimated_tokens: z.number().int(),
    budget: z.object({
      input_limit: z.number().int(),
      output_reserve: z.number().int(),
    }),
    estimated: z.boolean(),
  })
  .strict();
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

// ---------------------------------------------------------------------------
// 报警、来源、审批、复核
// ---------------------------------------------------------------------------

export const AlarmSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    source_id: z.string(),
    source_alarm_id: z.string(),
    equipment_id: z.string(),
    code: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    state: z.enum(['active', 'cleared', 'unknown']),
    raised_at: utcDateTime,
    cleared_at: utcDateTime.nullable(),
    message: z.string(),
    data_mode: DataModeSchema,
    idempotency_key: z.string(),
    created_at: utcDateTime,
  })
  .strict();
export type Alarm = z.infer<typeof AlarmSchema>;

export const SourceStatusSchema = z.enum([
  'configured',
  'unconfigured',
  'mock',
]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const DiagnosisSourceSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    kind: SourceKindSchema,
    name: z.string(),
    data_mode: DataModeSchema,
    status: SourceStatusSchema,
    auth_kind: z.string(),
    last_test_at: utcDateTime.nullable(),
    last_test_ok: z.boolean().nullable(),
    notes: z.string(),
  })
  .strict();
export type DiagnosisSource = z.infer<typeof DiagnosisSourceSchema>;

export const ReviewSchema = z
  .object({
    id: z.string(),
    run_id: z.string(),
    reviewer_id: z.string(),
    decision: z.enum(['accepted', 'rejected']),
    comment: z.string(),
    observations: z.array(z.string()),
    created_at: utcDateTime,
  })
  .strict();
export type Review = z.infer<typeof ReviewSchema>;

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'invalidated',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ControlReceiptStatusSchema = z.enum([
  'submitted',
  'acknowledged',
  'failed',
  'unknown',
]);
export type ControlReceiptStatus = z.infer<typeof ControlReceiptStatusSchema>;

export const ApprovalSchema = z
  .object({
    id: z.string(),
    run_id: z.string(),
    workspace_id: z.string(),
    action_id: z.string(),
    equipment_id: z.string(),
    risk_level: RiskLevelSchema,
    params_hash: z.string(),
    evidence_snapshot_hash: z.string(),
    requested_by: z.string(),
    approved_by: z.string().nullable(),
    status: ApprovalStatusSchema,
    receipt_status: ControlReceiptStatusSchema.nullable(),
    expires_at: utcDateTime,
    policy_version: z.string(),
    created_at: utcDateTime,
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

export const EvalCaseSchema = z
  .object({
    case_id: z.string(),
    category: z.enum([
      'sensor_anomaly',
      'mechanical_fault',
      'false_alarm',
      'multi_fault',
      'insufficient_safety',
    ]),
    split: z.enum(['dev', 'holdout']),
    input: z.object({
      equipment_id: z.string(),
      alarm_code: z.string(),
      window: WindowSchema,
      symptom: z.string(),
    }),
    source_snapshot: z.string(),
    clock: utcDateTime,
    fault_injections: z.array(z.string()),
    must_handoff: z.boolean(),
    required_tool_families: z.array(ToolNameSchema),
    forbidden_tool_families: z.array(ToolNameSchema),
    expected_root_causes: z.array(RootCauseCodeSchema),
    required_support: z.array(z.string()),
    required_contradictions: z.array(z.string()),
    citation_constraints: z.array(z.string()),
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalMetricsSchema = z
  .object({
    total: z.number().int(),
    passed: z.number().int(),
    citation_integrity: z.number(),
    /** 已实际 dispatch 的未授权调用；被策略拦截的请求不计入。 */
    unauthorized_calls: z.number().int(),
    /** 被网关/重复守卫正确拦截的尝试，用于证明安全机制生效。 */
    blocked_attempts: z.number().int(),
    missed_handoff: z.number().int(),
    counter_evidence_retained: z.number(),
    evidence_coverage: z.number(),
    required_tool_recall: z.number(),
    solvable_completion: z.number(),
    unnecessary_handoff: z.number(),
    top1_hit: z.number().nullable(),
    top3_hit: z.number().nullable(),
    multi_fault_coverage: z.number().nullable(),
    multi_fault_precision: z.number().nullable(),
    tool_selection_accuracy: z.number(),
    handoff_accuracy: z.number(),
    task_success_rate: z.number(),
    mean_latency_ms: z.number(),
    p95_latency_ms: z.number(),
    total_latency_ms: z.number(),
    model_calls: z.number().int(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    total_tokens: z.number().int(),
    model_call_failures: z.number().int(),
    /** 仅当配置了输入/输出每百万 token 单价且为 live 模式时计算。 */
    estimated_cost_usd: z.number().nullable(),
    /** 各比例指标的分母；0 表示该指标在本批用例中为 N/A。 */
    evidence_coverage_n: z.number().int(),
    required_tool_recall_n: z.number().int(),
    counter_evidence_n: z.number().int(),
    top1_cases: z.number().int(),
    top3_cases: z.number().int(),
    multi_fault_cases: z.number().int(),
    tool_selection_n: z.number().int(),
  })
  .strict();
export type EvalMetrics = z.infer<typeof EvalMetricsSchema>;

export const EvalCaseResultSchema = z
  .object({
    case_id: z.string(),
    category: z.string(),
    split: z.string(),
    run_id: z.string(),
    status: z.string(),
    passed: z.boolean(),
    failure_reasons: z.array(z.string()),
    predicted_root_causes: z.array(z.string()),
    required_tools_missing: z.array(z.string()),
    citation_issues: z.array(z.string()),
    handoff: z.boolean(),
    metrics: z.record(
      z.string(),
      z.union([z.number(), z.boolean(), z.string()]),
    ),
  })
  .strict();
export type EvalCaseResult = z.infer<typeof EvalCaseResultSchema>;
