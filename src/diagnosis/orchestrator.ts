import fs from 'node:fs';
import path from 'node:path';
import {
  QueryRequestSchema,
  type AlarmContext,
  type DataInvestigatorOutput,
  type EquipmentSnapshot,
  type Hypothesis,
  type HypothesisDraft,
  type HypothesisVerifierOutput,
  type KnowledgeRetrieverOutput,
  type QueryRequest,
  type Report,
  type ReportDraft,
  type ReportReviewerOutput,
  type Role,
  type Run,
  type Stage,
} from './contracts/domain.js';
import { detectControlIntent } from './analysis.js';
import { buildRoleContext, type BuiltContext } from './context-builder.js';
import type { DiagnosisEventBus } from './events.js';
import type { KnowledgeService } from './knowledge.js';
import { DiagnosisMcpClient } from './mcp-client.js';
import { RepeatGuard } from './repeat-guard.js';
import type { DiagnosisRepository } from './repository.js';
import {
  RoleRunnerError,
  type RoleCallInput,
  type RoleRunner,
} from './role-runner.js';
import {
  validateReport,
  validationMessages,
  validationSummary,
  type ReportValidationResult,
} from './report-validator.js';
import { ToolGateway } from './tool-gateway.js';
import { newId, nowIso } from './util.js';

const STAGES: Stage[] = [
  'confirm_status',
  'locate_anomaly',
  'generate_hypotheses',
  'verify_evidence',
  'produce_report',
];

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class RunCancelledError extends Error {
  readonly code = 'CANCELLED';
  constructor() {
    super('Run 已取消');
    this.name = 'RunCancelledError';
  }
}

export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';
  constructor() {
    super('Run 租约已丢失');
    this.name = 'LeaseLostError';
  }
}

export class AlreadyFinishedError extends Error {
  readonly code = 'ALREADY_FINISHED';
  constructor() {
    super('Run 已由其他执行者完成');
    this.name = 'AlreadyFinishedError';
  }
}

interface OrchestratorOptions {
  repo: DiagnosisRepository;
  knowledge: KnowledgeService;
  bus: DiagnosisEventBus;
  runner: RoleRunner;
  fixturesDir: string;
  mcpServerPath?: string;
  modelWindow?: number | null;
  leaseMs?: number;
  logDir?: string;
}

interface RunState {
  run: Run;
  stage: Stage;
  stageRounds: Record<string, number>;
  totalRounds: number;
  logicalCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  noNewEvidenceRounds: number;
  checkpoint: Record<string, unknown>;
  newEvidenceIds: string[];
}

function initialStageRounds(run: Run): Record<string, number> {
  const result: Record<string, number> = {};
  for (const stage of STAGES) result[stage] = run.stage_rounds[stage] ?? 0;
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asQueries(value: unknown): QueryRequest[] {
  if (!Array.isArray(value)) return [];
  const result: QueryRequest[] = [];
  for (const item of value) {
    const parsed = QueryRequestSchema.safeParse(item);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}

export class DiagnosisOrchestrator {
  constructor(private readonly options: OrchestratorOptions) {}

  private log(runId: string, message: string): void {
    try {
      const dir =
        this.options.logDir ?? path.join(process.cwd(), 'work/diagnosis/logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, `orchestrator-${runId}.log`),
        `${nowIso()} ${message}\n`,
        'utf8',
      );
    } catch {
      // 日志失败不应影响诊断主流程
    }
  }

  private emit(
    runId: string,
    type: Parameters<DiagnosisRepository['appendEvent']>[1],
    payload: Record<string, unknown> = {},
  ): void {
    const event = this.options.repo.appendEvent(runId, type, payload);
    this.options.bus.publish(event);
  }

  private checkpointOf(state: RunState): Record<string, unknown> {
    return state.checkpoint;
  }

  private scenarioWithdrawnDocuments(scenarioId: string | null): string[] {
    if (!scenarioId) return [];
    try {
      const file = path.join(
        this.options.fixturesDir,
        'scenarios',
        `${scenarioId}.json`,
      );
      if (!fs.existsSync(file)) return [];
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        withdrawn_documents?: unknown;
      };
      return Array.isArray(parsed.withdrawn_documents)
        ? parsed.withdrawn_documents.filter(
            (item): item is string => typeof item === 'string',
          )
        : [];
    } catch {
      return [];
    }
  }

  private async assertRunnable(
    state: RunState,
    owner: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted) throw new RunCancelledError();
    const fresh = this.options.repo.getRun(state.run.id);
    if (!fresh) throw new Error(`Run ${state.run.id} 不存在`);
    if (fresh.status === 'cancelled') throw new RunCancelledError();
    if (
      fresh.status === 'completed' ||
      fresh.status === 'failed' ||
      fresh.status === 'awaiting_human'
    ) {
      throw new AlreadyFinishedError();
    }
    if (owner && fresh.lease_owner) {
      if (fresh.lease_owner !== owner) throw new LeaseLostError();
      const ok = this.options.repo.renewLease(
        state.run.id,
        owner,
        this.options.leaseMs ?? 60_000,
      );
      if (!ok) throw new LeaseLostError();
    }
    const elapsed =
      Date.now() - Date.parse(state.run.started_at ?? state.run.created_at);
    if (elapsed > state.run.budget.run_wall_clock_ms) {
      throw new BudgetExceededError('Run 墙钟时间超限');
    }
  }

  private persist(
    state: RunState,
    patch: Partial<Parameters<DiagnosisRepository['updateRun']>[1]> = {},
  ): void {
    const runPatch = {
      status: state.run.status,
      stage: state.stage,
      stage_rounds: state.stageRounds,
      total_rounds: state.totalRounds,
      logical_calls: state.logicalCalls,
      model_calls: state.modelCalls,
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      no_new_evidence_rounds: state.noNewEvidenceRounds,
      checkpoint: state.checkpoint,
      ...patch,
    };
    this.options.repo.updateRun(state.run.id, runPatch);
    state.run = {
      ...state.run,
      ...runPatch,
      checkpoint: state.checkpoint,
    } as Run;
  }

  private equipmentSnapshot(state: RunState): EquipmentSnapshot {
    const equipment = this.options.repo.getEquipment(
      state.run.workspace_id,
      state.run.equipment_id,
    );
    if (!equipment) {
      throw new Error(`设备 ${state.run.equipment_id} 不在设备台账中`);
    }
    return {
      equipment_id: equipment.equipment_id,
      name: equipment.name,
      vendor: equipment.vendor,
      model: equipment.model,
      serial: equipment.serial,
      source_ids: equipment.source_ids,
    };
  }

  private alarmContext(state: RunState): AlarmContext | null {
    if (!state.run.alarm_id) return null;
    const alarm = this.options.repo.getAlarm(
      state.run.workspace_id,
      state.run.alarm_id,
    );
    if (!alarm) return null;
    return {
      alarm_id: alarm.id,
      code: alarm.code,
      severity: alarm.severity,
      raised_at: alarm.raised_at,
      message: alarm.message,
    };
  }

  private toolHistory(state: RunState): Array<{
    tool: string;
    role: string;
    status: string;
    error_code: string | null;
    policy_decision: string;
    args_hash: string;
    at: string;
  }> {
    return this.options.repo.listToolCalls(state.run.id).map((row) => ({
      tool: String(row.tool),
      role: String(row.role),
      status: String(row.status),
      error_code: (row.error_code as string | null) ?? null,
      policy_decision: String(row.policy_decision),
      args_hash: String(row.args_hash),
      at: String(row.started_at),
    }));
  }

  private currentRun(state: RunState): Run {
    return {
      ...state.run,
      stage: state.stage,
      stage_rounds: state.stageRounds,
      total_rounds: state.totalRounds,
      logical_calls: state.logicalCalls,
      model_calls: state.modelCalls,
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      no_new_evidence_rounds: state.noNewEvidenceRounds,
      checkpoint: state.checkpoint,
    };
  }

  private async callRole(
    state: RunState,
    role: Role,
    stage: Stage,
    options: { repairIssues?: string[]; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const nextRound = (state.stageRounds[stage] ?? 0) + 1;
    if (nextRound > state.run.budget.max_rounds_per_stage) {
      throw new BudgetExceededError('单阶段编排轮次超限');
    }
    if (state.totalRounds >= state.run.budget.max_rounds_total) {
      throw new BudgetExceededError('总编排轮次超限');
    }
    if (state.modelCalls >= state.run.budget.max_model_calls) {
      throw new BudgetExceededError('模型调用次数超限');
    }
    if (
      state.noNewEvidenceRounds >=
      state.run.budget.max_rounds_without_new_evidence
    ) {
      throw new BudgetExceededError('连续多轮没有新证据');
    }
    const equipment = this.equipmentSnapshot(state);
    const alarm = this.alarmContext(state);
    const evidence = this.options.repo.listEvidence(state.run.id);
    const hypotheses = this.options.repo.listHypotheses(state.run.id);
    const context = buildRoleContext({
      run: this.currentRun(state),
      role,
      stage,
      equipment,
      alarm,
      hypotheses,
      evidence,
      toolHistory: this.toolHistory(state),
      newEvidenceIds: state.newEvidenceIds,
      modelWindow: this.options.modelWindow ?? null,
      symptom: state.run.symptom,
    });
    if (
      state.inputTokens + context.manifest.estimated_tokens >
      state.run.budget.max_input_tokens
    ) {
      throw new BudgetExceededError('输入 token 预算超限');
    }
    this.options.repo.saveManifest(context.manifest);

    const callInput: RoleCallInput = {
      run: this.currentRun(state),
      role,
      stage,
      context,
      equipment,
      alarm,
      evidence,
      hypotheses,
      toolHistory: this.toolHistory(state),
      stageRound: nextRound,
      repairIssues: options.repairIssues,
      signal: options.signal,
    };

    let result: Awaited<ReturnType<RoleRunner['run']>> | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await this.options.runner.run({
          ...callInput,
          repairIssues:
            attempt === 0
              ? options.repairIssues
              : [
                  ...(options.repairIssues ?? []),
                  lastError instanceof Error
                    ? lastError.message
                    : '输出不符合角色 Schema，请严格按 Schema 返回 JSON。',
                ],
        });
        state.modelCalls += 1;
        break;
      } catch (error) {
        if (
          error instanceof RoleRunnerError &&
          error.code === 'INVALID_OUTPUT' &&
          attempt === 0
        ) {
          state.modelCalls += 1;
          lastError = error;
          this.log(
            state.run.id,
            `角色 ${role} 输出无效，进行 1 次修复调用：${error.message}`,
          );
          continue;
        }
        throw error;
      }
    }
    if (!result) {
      throw lastError instanceof Error
        ? lastError
        : new Error('角色调用没有返回结果');
    }
    if (result.outputTokens > state.run.budget.max_output_tokens) {
      throw new BudgetExceededError('单次模型输出 token 超限');
    }
    state.inputTokens += result.inputTokens;
    state.outputTokens += result.outputTokens;
    state.totalRounds += 1;
    state.stageRounds[stage] = nextRound;
    state.checkpoint.last_role = role;
    state.checkpoint.last_model = result.model;
    this.persist(state);
    this.log(
      state.run.id,
      `role=${role} stage=${stage} round=${nextRound} tokens=${result.inputTokens}/${result.outputTokens} latency=${result.latencyMs}ms`,
    );
    return result.output;
  }

  private async executeQueries(
    state: RunState,
    role: Role,
    stage: Stage,
    queries: QueryRequest[],
    gateway: ToolGateway,
    options: {
      signal?: AbortSignal;
      scenarioId: string | null;
      sourceAllowlist: string[] | null;
      withdrawnDocuments?: string[];
      owner?: string;
    },
  ): Promise<{ newEvidence: number; attempted: number }> {
    let newEvidence = 0;
    let attempted = 0;
    const collected: string[] = [];
    for (const request of queries) {
      if (state.logicalCalls >= state.run.budget.max_logical_tool_calls) {
        throw new BudgetExceededError('逻辑工具调用数超限');
      }
      await this.assertRunnable(state, options.owner, options.signal);
      attempted += 1;
      this.emit(state.run.id, 'tool.started', {
        tool: request.tool,
        role,
        target_hypothesis: request.target_hypothesis,
        evidence_gap: request.evidence_gap,
      });
      const outcome = await gateway.execute({
        run: this.currentRun(state),
        role,
        request,
        stageRound: state.stageRounds[stage] ?? 1,
        logicalCalls: state.logicalCalls,
        signal: options.signal,
        sourceAllowlist: options.sourceAllowlist,
        scenarioId: options.scenarioId,
        withdrawnDocuments: options.withdrawnDocuments,
      });
      state.logicalCalls += 1;
      if (
        options.signal?.aborted ||
        outcome.envelope.error?.code === 'CANCELLED'
      ) {
        throw new RunCancelledError();
      }
      for (const item of outcome.newEvidence) collected.push(item.id);
      newEvidence += outcome.newEvidence.length;
      this.emit(state.run.id, 'tool.finished', {
        tool: request.tool,
        status: outcome.envelope.status,
        policy_decision: outcome.policyDecision,
        evidence_count: outcome.newEvidence.length,
        error_code: outcome.envelope.error?.code ?? null,
      });
      this.persist(state);
    }
    if (attempted > 0) {
      if (newEvidence === 0) {
        state.noNewEvidenceRounds += 1;
      } else {
        state.noNewEvidenceRounds = 0;
      }
      state.newEvidenceIds = collected;
      state.checkpoint.new_evidence_ids = collected;
      this.persist(state);
    }
    return { newEvidence, attempted };
  }

  private deriveStatus(
    hypothesis: Hypothesis,
    handoff: boolean,
  ): Hypothesis['status'] {
    if (
      hypothesis.code === 'insufficient_evidence' &&
      (handoff || hypothesis.missing_evidence.length > 0)
    ) {
      return 'supported';
    }
    if (
      hypothesis.supporting_evidence_ids.length > 0 &&
      hypothesis.contradicting_evidence_ids.length === 0
    ) {
      return 'supported';
    }
    if (
      hypothesis.contradicting_evidence_ids.length > 0 &&
      hypothesis.supporting_evidence_ids.length === 0
    ) {
      return 'contradicted';
    }
    if (
      hypothesis.supporting_evidence_ids.length > 0 &&
      hypothesis.contradicting_evidence_ids.length > 0
    ) {
      return 'inconclusive';
    }
    return 'inconclusive';
  }

  private storeHypotheses(
    state: RunState,
    drafts: HypothesisDraft[],
    handoff: boolean,
  ): Hypothesis[] {
    const stored = this.options.repo.replaceHypotheses(state.run.id, drafts);
    for (const hypothesis of stored) {
      this.options.repo.updateHypothesisStatus(
        hypothesis.id,
        this.deriveStatus(hypothesis, handoff),
      );
    }
    const updated = this.options.repo.listHypotheses(state.run.id);
    this.emit(state.run.id, 'hypothesis.updated', {
      count: updated.length,
      codes: updated.map((item) => item.code),
      statuses: updated.map((item) => item.status),
    });
    return updated;
  }

  private insufficientDraft(state: RunState, reason: string): HypothesisDraft {
    const evidence = this.options.repo.listEvidence(state.run.id);
    return {
      code: 'insufficient_evidence',
      title: '证据不足，无法确认根因',
      description: reason,
      confidence: 'low',
      rationale: reason,
      supporting_evidence_ids: evidence.slice(0, 8).map((item) => item.id),
      contradicting_evidence_ids: [],
      missing_evidence: [
        '关键只读来源',
        '与设备匹配的手册版本',
        '现场检查记录',
      ],
      next_check: '补齐来源与手册后重新诊断',
    };
  }

  private ensureInsufficientHypothesis(
    state: RunState,
    reason: string,
  ): Hypothesis[] {
    const existing = this.options.repo.listHypotheses(state.run.id);
    const drafts: HypothesisDraft[] = existing.map((hypothesis) => ({
      code: hypothesis.code,
      title: hypothesis.title,
      description: hypothesis.description,
      confidence: hypothesis.confidence,
      rationale: hypothesis.rationale,
      supporting_evidence_ids: hypothesis.supporting_evidence_ids,
      contradicting_evidence_ids: hypothesis.contradicting_evidence_ids,
      missing_evidence: hypothesis.missing_evidence,
      next_check: hypothesis.next_check,
    }));
    if (!drafts.some((draft) => draft.code === 'insufficient_evidence')) {
      drafts.push(this.insufficientDraft(state, reason));
    }
    return this.storeHypotheses(state, drafts, true);
  }

  private buildFullReport(
    state: RunState,
    draft: ReportDraft,
    handoffReason: string | null,
  ): Report {
    const equipment = this.equipmentSnapshot(state);
    const alarm = this.alarmContext(state) ?? {
      alarm_id: 'manual',
      code: 'MANUAL',
      severity: 'low',
      raised_at: state.run.created_at,
      message: '人工发起诊断，无绑定报警',
    };
    const hypotheses = draft.hypotheses;
    const insufficient = hypotheses.some(
      (hypothesis) =>
        hypothesis.code === 'insufficient_evidence' &&
        hypothesis.status === 'supported',
    );
    const limitations = [...draft.limitations];
    if (
      state.run.data_mode === 'mock' &&
      !limitations.some((item) => /Mock|模拟/.test(item))
    ) {
      limitations.push('当前为 Mock 模拟数据模式，不能作为现场维修依据。');
    }
    if (
      state.run.model_mode === 'fixture' &&
      !limitations.some((item) => /Fixture|预录|规则推理/.test(item))
    ) {
      limitations.push(
        '当前使用 FixtureRoleRunner 预录规则推理，不是真实模型输出。',
      );
    }
    return {
      report_version: '1',
      run_id: state.run.id,
      equipment_snapshot: equipment,
      alarm_context: alarm,
      data_mode: state.run.data_mode,
      model_mode: state.run.model_mode,
      as_of: nowIso(),
      limitations,
      observations: draft.observations,
      hypotheses,
      checks: draft.checks,
      recommendations: draft.recommendations,
      unresolved_questions: draft.unresolved_questions,
      handoff_reason: handoffReason ?? draft.handoff_reason,
      review_status: 'pending',
      conclusion_status: insufficient ? 'insufficient_evidence' : 'hypothesis',
    };
  }

  private fallbackReportDraft(state: RunState, reason: string): ReportDraft {
    const evidence = this.options.repo.listEvidence(state.run.id);
    const observations = evidence.slice(0, 6).map((item, index) => ({
      id: `obs_fallback_${index + 1}`,
      text:
        item.payload.kind === 'telemetry_series'
          ? `${item.payload.metric} 时间序列（${item.payload.stats.count} 点，缺失 ${item.payload.stats.missing}）。`
          : item.payload.kind === 'alarm'
            ? `报警 ${item.payload.code}：${item.payload.message}。`
            : `已入库证据 ${item.payload.kind}。`,
      evidence_ids: [item.id],
    }));
    return {
      limitations: [
        ...(state.run.data_mode === 'mock'
          ? ['当前为 Mock 模拟数据模式，不能作为现场维修依据。']
          : []),
        ...(state.run.model_mode === 'fixture'
          ? ['当前使用 FixtureRoleRunner 预录规则推理，不是真实模型输出。']
          : []),
      ],
      observations,
      hypotheses: this.options.repo.listHypotheses(state.run.id),
      checks: [
        {
          id: 'chk_handoff',
          purpose: '补齐关键证据后重新诊断',
          preconditions: ['明确缺失来源'],
          steps: ['恢复关键只读来源', '确认适用手册版本', '补充现场检查记录'],
          expected_observation: '关键来源可用且证据齐全后重新诊断',
          risk: 'low',
          role: '诊断平台管理员/工程师',
          evidence_ids: [],
          requires_human: true,
        },
      ],
      recommendations: [
        {
          id: 'rec_handoff',
          text: '当前证据不足或预算已耗尽，禁止据此安排更换或控制操作；先补齐证据。',
          evidence_ids: [],
          conditions: ['关键来源恢复'],
          requires_human: true,
          control_execution: 'disabled',
        },
      ],
      unresolved_questions: [reason],
      handoff_reason: reason,
    };
  }

  private finishWithReport(
    state: RunState,
    report: Report,
    validation: ReportValidationResult,
    options: { owner?: string; error?: string | null } = {},
  ): Run {
    this.options.repo.saveReport(
      state.run.id,
      report,
      validationSummary(validation),
    );
    state.run = {
      ...state.run,
      status: 'awaiting_human',
      review_status: 'pending',
      conclusion_status: report.conclusion_status,
      handoff_reason: report.handoff_reason,
      finished_at: nowIso(),
      error: options.error ?? null,
    };
    this.persist(state, {
      status: 'awaiting_human',
      review_status: 'pending',
      conclusion_status: report.conclusion_status,
      handoff_reason: report.handoff_reason,
      finished_at: state.run.finished_at,
      error: options.error ?? null,
    });
    this.emit(state.run.id, 'report.ready', {
      report_hash: validation.valid ? 'validated' : 'validation_failed',
      errors: validation.errors.length,
      warnings: validation.warnings.length,
      conclusion_status: report.conclusion_status,
    });
    this.emit(state.run.id, 'review.required', {
      handoff_reason: report.handoff_reason,
      validation_errors: validation.errors.map((item) => item.code),
    });
    this.emit(state.run.id, 'run.awaiting_human', {
      handoff_reason: report.handoff_reason,
    });
    if (options.owner) this.options.repo.releaseLease(state.run.id);
    this.log(
      state.run.id,
      `finished status=awaiting_human conclusion=${report.conclusion_status} handoff=${Boolean(report.handoff_reason)} validation_errors=${validation.errors.length}`,
    );
    return this.options.repo.getRun(state.run.id) ?? state.run;
  }

  private async handoff(
    state: RunState,
    reason: string,
    options: { owner?: string; error?: string | null } = {},
  ): Promise<Run> {
    state.checkpoint.handoff_reason = reason;
    this.persist(state);
    this.ensureInsufficientHypothesis(state, reason);
    const draft = this.fallbackReportDraft(state, reason);
    const report = this.buildFullReport(state, draft, reason);
    const validation = validateReport({
      report,
      run: this.currentRun(state),
      equipment: this.equipmentSnapshot(state),
      alarm: this.alarmContext(state),
      evidence: this.options.repo.listEvidence(state.run.id),
      hypotheses: this.options.repo.listHypotheses(state.run.id),
      toolCalls: this.options.repo.listToolCalls(state.run.id).map((row) => ({
        tool: String(row.tool),
        status: String(row.status),
        policy_decision: String(row.policy_decision),
        error_code: (row.error_code as string | null) ?? null,
      })),
    });
    return this.finishWithReport(state, report, validation, options);
  }

  private async fail(
    state: RunState,
    error: unknown,
    owner?: string,
  ): Promise<Run> {
    const message = error instanceof Error ? error.message : String(error);
    state.run = {
      ...state.run,
      status: 'failed',
      error: message,
      finished_at: nowIso(),
    };
    this.persist(state, {
      status: 'failed',
      error: message,
      finished_at: state.run.finished_at,
    });
    this.emit(state.run.id, 'run.failed', { error: message });
    if (owner) this.options.repo.releaseLease(state.run.id);
    this.log(state.run.id, `failed: ${message}`);
    return this.options.repo.getRun(state.run.id) ?? state.run;
  }

  private async cancel(state: RunState, owner?: string): Promise<Run> {
    state.run = {
      ...state.run,
      status: 'cancelled',
      finished_at: nowIso(),
    };
    this.persist(state, {
      status: 'cancelled',
      finished_at: state.run.finished_at,
    });
    this.emit(state.run.id, 'run.cancelled', {});
    if (owner) this.options.repo.releaseLease(state.run.id);
    return this.options.repo.getRun(state.run.id) ?? state.run;
  }

  private async runConfirmStage(
    state: RunState,
    gateway: ToolGateway,
    options: {
      signal?: AbortSignal;
      scenarioId: string | null;
      sourceAllowlist: string[] | null;
      owner?: string;
    },
  ): Promise<'advance' | 'handoff'> {
    const pending = asQueries(state.checkpoint.pending_queries);
    if (pending.length > 0) {
      await this.executeQueries(
        state,
        'data_investigator',
        'confirm_status',
        pending,
        gateway,
        options,
      );
      delete state.checkpoint.pending_queries;
      this.persist(state);
      return 'advance';
    }
    if ((state.stageRounds.confirm_status ?? 0) > 0) return 'advance';
    await this.assertRunnable(state, options.owner, options.signal);
    const output = (await this.callRole(
      state,
      'data_investigator',
      'confirm_status',
      { signal: options.signal },
    )) as DataInvestigatorOutput;
    if (output.queries.length > 0) {
      state.checkpoint.pending_queries = output.queries;
      this.persist(state);
      await this.executeQueries(
        state,
        'data_investigator',
        'confirm_status',
        output.queries,
        gateway,
        options,
      );
      delete state.checkpoint.pending_queries;
      this.persist(state);
    }
    return 'advance';
  }

  private async runLocateStage(
    state: RunState,
    gateway: ToolGateway,
    options: {
      signal?: AbortSignal;
      scenarioId: string | null;
      sourceAllowlist: string[] | null;
      owner?: string;
    },
  ): Promise<'advance' | 'handoff'> {
    const pending = asQueries(state.checkpoint.pending_queries);
    if (pending.length > 0) {
      await this.executeQueries(
        state,
        'data_investigator',
        'locate_anomaly',
        pending,
        gateway,
        options,
      );
      delete state.checkpoint.pending_queries;
      this.persist(state);
      return 'advance';
    }
    if ((state.stageRounds.locate_anomaly ?? 0) > 0) return 'advance';
    await this.assertRunnable(state, options.owner, options.signal);
    const output = (await this.callRole(
      state,
      'data_investigator',
      'locate_anomaly',
      { signal: options.signal },
    )) as DataInvestigatorOutput;
    if (output.queries.length > 0) {
      state.checkpoint.pending_queries = output.queries;
      this.persist(state);
      await this.executeQueries(
        state,
        'data_investigator',
        'locate_anomaly',
        output.queries,
        gateway,
        options,
      );
      delete state.checkpoint.pending_queries;
      this.persist(state);
    }
    return 'advance';
  }

  private async runGenerateStage(
    state: RunState,
    gateway: ToolGateway,
    options: {
      signal?: AbortSignal;
      scenarioId: string | null;
      sourceAllowlist: string[] | null;
      owner?: string;
    },
  ): Promise<'advance' | 'handoff'> {
    const pending = asQueries(state.checkpoint.pending_queries);
    if (pending.length > 0) {
      await this.executeQueries(
        state,
        'knowledge_retriever',
        'generate_hypotheses',
        pending,
        gateway,
        options,
      );
      delete state.checkpoint.pending_queries;
      this.persist(state);
    }
    if ((state.stageRounds.generate_hypotheses ?? 0) === 0) {
      await this.assertRunnable(state, options.owner, options.signal);
      const output = (await this.callRole(
        state,
        'knowledge_retriever',
        'generate_hypotheses',
        { signal: options.signal },
      )) as KnowledgeRetrieverOutput;
      if (output.queries.length > 0) {
        state.checkpoint.pending_queries = output.queries;
        this.persist(state);
        await this.executeQueries(
          state,
          'knowledge_retriever',
          'generate_hypotheses',
          output.queries,
          gateway,
          options,
        );
        delete state.checkpoint.pending_queries;
        this.persist(state);
      }
    }
    if ((state.stageRounds.generate_hypotheses ?? 0) < 2) {
      await this.assertRunnable(state, options.owner, options.signal);
      const output = (await this.callRole(
        state,
        'hypothesis_verifier',
        'generate_hypotheses',
        { signal: options.signal },
      )) as HypothesisVerifierOutput;
      if (output.hypotheses.length === 0) {
        return 'handoff';
      }
      state.checkpoint.pending_checks = output.next_checks;
      this.persist(state);
      const control = detectControlIntent(state.run.symptom);
      this.storeHypotheses(state, output.hypotheses, control);
    }
    return 'advance';
  }

  private async runVerifyStage(
    state: RunState,
    gateway: ToolGateway,
    options: {
      signal?: AbortSignal;
      scenarioId: string | null;
      sourceAllowlist: string[] | null;
      owner?: string;
    },
  ): Promise<'advance' | 'handoff'> {
    const pending = asQueries(state.checkpoint.pending_checks);
    if (pending.length > 0) {
      await this.executeQueries(
        state,
        'hypothesis_verifier',
        'verify_evidence',
        pending,
        gateway,
        options,
      );
      delete state.checkpoint.pending_checks;
      state.checkpoint.verify_needs_final_call = true;
      this.persist(state);
    }
    if ((state.stageRounds.verify_evidence ?? 0) === 0) {
      await this.assertRunnable(state, options.owner, options.signal);
      const output = (await this.callRole(
        state,
        'hypothesis_verifier',
        'verify_evidence',
        { signal: options.signal },
      )) as HypothesisVerifierOutput;
      const control = detectControlIntent(state.run.symptom);
      const stored = this.storeHypotheses(state, output.hypotheses, control);
      if (output.next_checks.length > 0) {
        state.checkpoint.pending_checks = output.next_checks;
        this.persist(state);
        await this.executeQueries(
          state,
          'hypothesis_verifier',
          'verify_evidence',
          output.next_checks,
          gateway,
          options,
        );
        delete state.checkpoint.pending_checks;
        state.checkpoint.verify_needs_final_call = true;
        this.persist(state);
      }
      if (stored.length === 0) return 'handoff';
    }
    if (state.checkpoint.verify_needs_final_call) {
      await this.assertRunnable(state, options.owner, options.signal);
      const output = (await this.callRole(
        state,
        'hypothesis_verifier',
        'verify_evidence',
        { signal: options.signal },
      )) as HypothesisVerifierOutput;
      const control = detectControlIntent(state.run.symptom);
      this.storeHypotheses(state, output.hypotheses, control);
      delete state.checkpoint.verify_needs_final_call;
      this.persist(state);
    }

    const hypotheses = this.options.repo.listHypotheses(state.run.id);
    const supported = hypotheses.filter(
      (hypothesis) => hypothesis.status === 'supported',
    );
    const insufficient = supported.some(
      (hypothesis) => hypothesis.code === 'insufficient_evidence',
    );
    const diagnostic = supported.filter(
      (hypothesis) =>
        hypothesis.code !== 'insufficient_evidence' &&
        hypothesis.code !== 'unknown',
    );
    const control = detectControlIntent(state.run.symptom);
    let handoffReason: string | null = null;
    if (insufficient) {
      handoffReason =
        '存在未解决的关键证据缺口，当前不能形成可核查的确定结论。';
    } else if (control) {
      handoffReason =
        '请求包含设备控制/复位意图；本版只提供只读诊断，控制必须由工程师按规程现场执行。';
    } else if (diagnostic.length === 0) {
      handoffReason = '没有可支持的根因假设，需人工复核并补充证据。';
    }
    state.checkpoint.handoff_reason = handoffReason;
    this.persist(state);
    // 控制意图需要转人工，但仍应生成带证据的完整报告；
    // 只有证据不足或没有任何可支持假设时才走兜底报告。
    if (insufficient || diagnostic.length === 0) return 'handoff';
    return 'advance';
  }

  private async runReportStage(
    state: RunState,
    options: { signal?: AbortSignal; owner?: string },
  ): Promise<'finished'> {
    const existing = this.options.repo.getReport(state.run.id);
    if (existing) {
      state.run = {
        ...state.run,
        status: 'awaiting_human',
        review_status: 'pending',
        conclusion_status: existing.report.conclusion_status,
        handoff_reason: existing.report.handoff_reason,
        finished_at: state.run.finished_at ?? nowIso(),
      };
      this.persist(state, {
        status: 'awaiting_human',
        review_status: 'pending',
        conclusion_status: existing.report.conclusion_status,
        handoff_reason: existing.report.handoff_reason,
        finished_at: state.run.finished_at,
      });
      if (options.owner) this.options.repo.releaseLease(state.run.id);
      return 'finished';
    }
    await this.assertRunnable(state, options.owner, options.signal);
    const output = (await this.callRole(
      state,
      'report_reviewer',
      'produce_report',
      { signal: options.signal },
    )) as ReportReviewerOutput;
    let draft = output.report;
    const handoffReason =
      (state.checkpoint.handoff_reason as string | null | undefined) ?? null;
    let report = this.buildFullReport(state, draft, handoffReason);
    let validation = validateReport({
      report,
      run: this.currentRun(state),
      equipment: this.equipmentSnapshot(state),
      alarm: this.alarmContext(state),
      evidence: this.options.repo.listEvidence(state.run.id),
      hypotheses: this.options.repo.listHypotheses(state.run.id),
      toolCalls: this.options.repo.listToolCalls(state.run.id).map((row) => ({
        tool: String(row.tool),
        status: String(row.status),
        policy_decision: String(row.policy_decision),
        error_code: (row.error_code as string | null) ?? null,
      })),
    });

    if (!validation.valid && !state.checkpoint.report_repair_attempted) {
      state.checkpoint.report_repair_attempted = true;
      this.persist(state);
      const repaired = (await this.callRole(
        state,
        'report_reviewer',
        'produce_report',
        {
          signal: options.signal,
          repairIssues: validationMessages(validation),
        },
      )) as ReportReviewerOutput;
      draft = repaired.report;
      report = this.buildFullReport(state, draft, handoffReason);
      validation = validateReport({
        report,
        run: this.currentRun(state),
        equipment: this.equipmentSnapshot(state),
        alarm: this.alarmContext(state),
        evidence: this.options.repo.listEvidence(state.run.id),
        hypotheses: this.options.repo.listHypotheses(state.run.id),
        toolCalls: this.options.repo.listToolCalls(state.run.id).map((row) => ({
          tool: String(row.tool),
          status: String(row.status),
          policy_decision: String(row.policy_decision),
          error_code: (row.error_code as string | null) ?? null,
        })),
      });
    }

    if (!validation.valid) {
      const reason = `报告校验失败（${validation.errors.length} 项）：${validation.errors
        .slice(0, 3)
        .map((item) => item.code)
        .join(', ')}`;
      const finalReport: Report = {
        ...report,
        handoff_reason: report.handoff_reason ?? reason,
        conclusion_status: 'insufficient_evidence',
      };
      this.finishWithReport(state, finalReport, validation, {
        owner: options.owner,
        error: null,
      });
      return 'finished';
    }
    this.finishWithReport(state, report, validation, {
      owner: options.owner,
    });
    return 'finished';
  }

  async execute(
    runId: string,
    options: { owner?: string; signal?: AbortSignal } = {},
  ): Promise<Run> {
    const run = this.options.repo.getRun(runId);
    if (!run) throw new Error(`Run ${runId} 不存在`);
    if (
      run.status === 'completed' ||
      run.status === 'cancelled' ||
      run.status === 'failed' ||
      run.status === 'awaiting_human'
    ) {
      return run;
    }
    if (run.status === 'queued') {
      if (options.owner) {
        const claimed = this.options.repo.claimRun(
          runId,
          options.owner,
          this.options.leaseMs ?? 60_000,
        );
        if (!claimed) {
          return this.options.repo.getRun(runId) ?? run;
        }
      } else {
        this.options.repo.updateRun(runId, {
          status: 'running',
          started_at: nowIso(),
        });
      }
      this.emit(runId, 'run.started', {});
    } else if (
      !this.options.repo
        .listEvents(runId, 0, 500)
        .some((event) => event.type === 'run.started')
    ) {
      // Worker 会先把 queued 状态 CAS 成 running，再调用 execute；崩溃恢复
      // 也可能直接进入 running。此时补发 run.started，保证时间线完整，
      // 同时避免续跑时重复插入。
      this.emit(runId, 'run.started', {});
    }
    const fresh = this.options.repo.getRun(runId)!;
    const state: RunState = {
      run: fresh,
      stage: fresh.stage,
      stageRounds: initialStageRounds(fresh),
      totalRounds: fresh.total_rounds,
      logicalCalls: fresh.logical_calls,
      modelCalls: fresh.model_calls,
      inputTokens: fresh.input_tokens,
      outputTokens: fresh.output_tokens,
      noNewEvidenceRounds: fresh.no_new_evidence_rounds,
      checkpoint: asRecord(fresh.checkpoint),
      newEvidenceIds: Array.isArray(fresh.checkpoint?.new_evidence_ids)
        ? (fresh.checkpoint!.new_evidence_ids as string[])
        : [],
    };
    const scenarioId = this.options.repo.getRunScenario(runId);
    const callLogDir =
      this.options.logDir ?? path.join(process.cwd(), 'work/diagnosis/logs');
    fs.mkdirSync(callLogDir, { recursive: true });
    const mcp = new DiagnosisMcpClient({
      workspaceId: fresh.workspace_id,
      runId: fresh.id,
      dataMode: fresh.data_mode,
      scenarioId,
      fixturesDir: this.options.fixturesDir,
      now: fresh.window.end,
      sourceAllowlist: Array.isArray(state.checkpoint.source_allowlist)
        ? (state.checkpoint.source_allowlist as string[])
        : null,
      timeoutMs: fresh.budget.source_timeout_ms,
      callLog: path.join(callLogDir, `mcp-${fresh.id}.jsonl`),
      serverPath: this.options.mcpServerPath,
    });
    const gateway = new ToolGateway({
      repo: this.options.repo,
      knowledge: this.options.knowledge,
      mcp,
      repeatGuard: new RepeatGuard(),
      bus: this.options.bus,
    });
    const queryOptions = {
      signal: options.signal,
      scenarioId,
      sourceAllowlist: Array.isArray(state.checkpoint.source_allowlist)
        ? (state.checkpoint.source_allowlist as string[])
        : null,
      withdrawnDocuments: this.scenarioWithdrawnDocuments(scenarioId),
      owner: options.owner,
    };

    try {
      let index = STAGES.indexOf(state.stage);
      if (index < 0) index = 0;
      while (index < STAGES.length) {
        const stage = STAGES[index];
        state.stage = stage;
        await this.assertRunnable(state, options.owner, options.signal);
        let outcome: 'advance' | 'handoff' = 'advance';
        if (stage === 'confirm_status') {
          outcome = await this.runConfirmStage(state, gateway, queryOptions);
        } else if (stage === 'locate_anomaly') {
          outcome = await this.runLocateStage(state, gateway, queryOptions);
        } else if (stage === 'generate_hypotheses') {
          outcome = await this.runGenerateStage(state, gateway, queryOptions);
        } else if (stage === 'verify_evidence') {
          outcome = await this.runVerifyStage(state, gateway, queryOptions);
        } else {
          await this.runReportStage(state, options);
          return this.options.repo.getRun(runId) ?? state.run;
        }
        if (outcome === 'handoff') {
          return await this.handoff(
            state,
            (state.checkpoint.handoff_reason as string | undefined) ??
              '证据不足或预算受限，转人工处理。',
            { owner: options.owner },
          );
        }
        index += 1;
        if (index < STAGES.length) {
          const next = STAGES[index];
          const from = state.stage;
          state.stage = next;
          this.persist(state);
          this.emit(runId, 'stage.changed', { from, to: next });
        }
      }
      const finalRun = this.options.repo.getRun(runId) ?? state.run;
      if (finalRun.status === 'running') {
        return await this.handoff(
          state,
          '诊断流程结束但未生成报告，转人工处理。',
          { owner: options.owner },
        );
      }
      return finalRun;
    } catch (error) {
      if (error instanceof AlreadyFinishedError) {
        return this.options.repo.getRun(runId) ?? state.run;
      }
      if (error instanceof RunCancelledError) {
        return await this.cancel(state, options.owner);
      }
      if (error instanceof LeaseLostError) {
        this.log(runId, 'lease lost; another worker owns the run');
        return this.options.repo.getRun(runId) ?? state.run;
      }
      if (error instanceof BudgetExceededError) {
        return await this.handoff(state, error.message, {
          owner: options.owner,
        });
      }
      if (error instanceof RoleRunnerError && error.code === 'CANCELLED') {
        return await this.cancel(state, options.owner);
      }
      if (error instanceof RoleRunnerError && error.code === 'UNCONFIGURED') {
        return await this.handoff(state, error.message, {
          owner: options.owner,
          error: error.message,
        });
      }
      return await this.fail(state, error, options.owner);
    } finally {
      await mcp.close();
    }
  }
}
