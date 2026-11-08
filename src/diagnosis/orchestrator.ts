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
import {
  deriveAnomalyLedger,
  deriveTelemetryFeatures,
  detectControlIntent,
} from './analysis.js';
import {
  buildRoleContext,
  summarizeToolArgs,
  type BuiltContext,
} from './context-builder.js';
import {
  AlreadyFinishedError,
  BudgetExceededError,
  LeaseLostError,
  RunCancelledError,
} from './errors.js';
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

function toolRequestsFromOutput(output: unknown): unknown[] {
  if (!output || typeof output !== 'object') return [];
  const value = output as { queries?: unknown; next_checks?: unknown };
  if (Array.isArray(value.queries)) return value.queries;
  if (Array.isArray(value.next_checks)) return value.next_checks;
  return [];
}

function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2_000,
  );
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

const REPORT_OUTPUT_RESERVE = 4_500;

function outputAllowance(stage: Stage, role: Role, remaining: number): number {
  const reserve = stage === 'produce_report' ? 0 : REPORT_OUTPUT_RESERVE;
  const available = remaining - reserve;
  if (available < 400) {
    throw new BudgetExceededError(
      '模型输出预算不足：为报告生成保留额度后无法继续当前阶段',
    );
  }
  const cap =
    stage === 'produce_report'
      ? 4_500
      : role === 'hypothesis_verifier'
        ? 2_200
        : 1_200;
  return Math.min(cap, available);
}

export {
  AlreadyFinishedError,
  BudgetExceededError,
  LeaseLostError,
  RunCancelledError,
} from './errors.js';

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
  /** 当前 Worker 持有的租约令牌；0 表示无租约的直接执行。 */
  leaseToken: number;
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

  /**
   * 新检索必须同时排除数据库里已撤回的文档与场景回放声明的撤回文档；
   * 历史报告中的旧引用仍由报告校验器保留。
   */
  private withdrawnDocuments(
    workspaceId: string,
    scenarioId: string | null,
  ): string[] {
    const fromRepo = this.options.repo
      .listDocuments(workspaceId)
      .filter((document) => document.withdrawn)
      .map((document) => document.document_id);
    return [
      ...new Set([...fromRepo, ...this.scenarioWithdrawnDocuments(scenarioId)]),
    ];
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
      if (
        fresh.lease_owner !== owner ||
        fresh.lease_token !== state.leaseToken
      ) {
        throw new LeaseLostError();
      }
      const ok = this.options.repo.renewLease(
        state.run.id,
        owner,
        state.leaseToken,
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
    const fresh = this.options.repo.getRun(state.run.id);
    if (!fresh || fresh.lease_token !== state.leaseToken) {
      throw new LeaseLostError();
    }
    if (fresh.status === 'cancelled' && state.run.status !== 'cancelled') {
      throw new RunCancelledError();
    }
    if (
      (fresh.status === 'awaiting_human' ||
        fresh.status === 'completed' ||
        fresh.status === 'failed') &&
      state.run.status === 'running'
    ) {
      throw new AlreadyFinishedError();
    }
    const updated = this.options.repo.updateRunFenced(
      state.run.id,
      state.leaseToken,
      runPatch,
    );
    if (!updated) throw new LeaseLostError();
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
      manual_document_id: equipment.manual_document_id ?? null,
      manual_version: equipment.manual_version ?? null,
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
    args_summary: string;
    at: string;
  }> {
    return this.options.repo.listToolCalls(state.run.id).map((row) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(row.args_json));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // 历史脏数据不应阻断上下文构建；退化为只显示 args hash。
      }
      return {
        tool: String(row.tool),
        role: String(row.role),
        status: String(row.status),
        error_code: (row.error_code as string | null) ?? null,
        policy_decision: String(row.policy_decision),
        args_hash: String(row.args_hash),
        args_summary: summarizeToolArgs(String(row.tool), args),
        at: String(row.started_at),
      };
    });
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
    options: {
      repairIssues?: string[];
      focusAnomalies?: string[];
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    const nextRound = (state.stageRounds[stage] ?? 0) + 1;
    if (nextRound > state.run.budget.max_rounds_per_stage) {
      throw new BudgetExceededError('单阶段编排轮次超限');
    }
    // 非报告阶段必须给 produce_report 留下至少 1 轮；否则验证阶段的
    // 最后一次调用会把总轮次耗尽，报告阶段和预算回退都无法再执行。
    const reportRoundReserve = stage === 'produce_report' ? 0 : 1;
    if (
      state.totalRounds >=
      state.run.budget.max_rounds_total - reportRoundReserve
    ) {
      throw new BudgetExceededError(
        stage === 'produce_report'
          ? '总编排轮次超限'
          : '总编排轮次超限：需为报告阶段保留 1 轮',
      );
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
    const manualWithdrawn = Boolean(
      equipment.manual_document_id &&
      this.withdrawnDocuments(
        state.run.workspace_id,
        this.options.repo.getRunScenario(state.run.id),
      ).includes(equipment.manual_document_id),
    );
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
      manualWithdrawn,
      focusAnomalies: options.focusAnomalies,
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

    const deadlineAt = this.deadlineAt(state);
    let result: Awaited<ReturnType<RoleRunner['run']>> | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingOutput =
        state.run.budget.max_output_tokens - state.outputTokens;
      if (remainingOutput <= 0) {
        throw new BudgetExceededError('累计模型输出 token 预算已耗尽');
      }
      const maxOutputTokens = outputAllowance(stage, role, remainingOutput);
      this.reserveModelCall(state);
      const attemptStarted = Date.now();
      let retryReserved = 0;
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
          limits: {
            maxOutputTokens,
            deadlineAt,
            onRequest: () => {
              // 传输层重试同样占用 Run 的模型调用与时间预算。
              retryReserved += 1;
              this.reserveModelCall(state);
            },
          },
        });
        this.settleUsage(state, result.inputTokens, result.outputTokens);
        this.options.repo.recordModelCall({
          id: newId('mc'),
          runId: state.run.id,
          role,
          stage,
          round: nextRound,
          attempt: attempt + 1,
          model: result.model,
          mode: result.mode,
          status: 'success',
          errorCode: null,
          failureReason: null,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
          toolRequests: toolRequestsFromOutput(result.output),
          rawOutput: result.raw ?? null,
        });
        // 自定义 runner 若自行重试但没有回调，按报告的实际请求数补记账。
        const unreportedRetries = Math.max(
          0,
          (result.attempts ?? 1) - 1 - retryReserved,
        );
        for (let index = 0; index < unreportedRetries; index += 1) {
          this.reserveModelCall(state);
        }
        break;
      } catch (error) {
        if (error instanceof BudgetExceededError) throw error;
        const runnerError = error instanceof RoleRunnerError ? error : null;
        this.options.repo.recordModelCall({
          id: newId('mc'),
          runId: state.run.id,
          role,
          stage,
          round: nextRound,
          attempt: attempt + 1,
          model: this.options.runner.model,
          mode: this.options.runner.mode,
          status: 'error',
          errorCode: runnerError?.code ?? 'MODEL_ERROR',
          failureReason: failureText(error),
          inputTokens: runnerError?.usage?.inputTokens ?? 0,
          outputTokens: runnerError?.usage?.outputTokens ?? 0,
          latencyMs: Date.now() - attemptStarted,
          toolRequests: [],
          rawOutput: runnerError?.rawOutput ?? null,
        });
        if (runnerError) {
          if (runnerError.usage) {
            this.settleUsage(
              state,
              runnerError.usage.inputTokens,
              runnerError.usage.outputTokens,
            );
          }
          const unreportedRetries = Math.max(
            0,
            (runnerError.attempts ?? 1) - 1 - retryReserved,
          );
          for (let index = 0; index < unreportedRetries; index += 1) {
            this.reserveModelCall(state);
          }
          if (runnerError.code === 'INVALID_OUTPUT' && attempt === 0) {
            lastError = runnerError;
            this.persist(state);
            this.log(
              state.run.id,
              `角色 ${role} 输出无效，进行 1 次修复调用：${runnerError.message}`,
            );
            continue;
          }
        }
        throw error;
      }
    }
    if (!result) {
      throw lastError instanceof Error
        ? lastError
        : new Error('角色调用没有返回结果');
    }
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

  private deadlineAt(state: RunState): number {
    return (
      Date.parse(state.run.started_at ?? state.run.created_at) +
      state.run.budget.run_wall_clock_ms
    );
  }

  private reserveModelCall(state: RunState): void {
    if (state.modelCalls >= state.run.budget.max_model_calls) {
      throw new BudgetExceededError('模型调用次数超限');
    }
    if (Date.now() > this.deadlineAt(state)) {
      throw new BudgetExceededError('Run 墙钟时间超限');
    }
    state.modelCalls += 1;
  }

  private settleUsage(
    state: RunState,
    inputTokens: number,
    outputTokens: number,
  ): void {
    state.inputTokens += Math.max(0, Math.trunc(inputTokens));
    state.outputTokens += Math.max(0, Math.trunc(outputTokens));
    if (
      state.inputTokens > state.run.budget.max_input_tokens ||
      state.outputTokens > state.run.budget.max_output_tokens
    ) {
      // 实际 usage 必须如实记账，即使模型端违反了请求中的上限。
      this.persist(state);
      throw new BudgetExceededError(
        state.outputTokens > state.run.budget.max_output_tokens
          ? '累计模型输出 token 预算超限'
          : '累计模型输入 token 预算超限',
      );
    }
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
        timeoutMs: Math.max(1, this.deadlineAt(state) - Date.now()),
        leaseToken: state.leaseToken,
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
    declared?: Hypothesis['status'],
  ): Hypothesis['status'] {
    if (declared) {
      // 存储层先做一致性归一化：声明 supported 但仍有未处理反证，
      // 或声明 contradicted 却没有任何反证，都不能作为可复核状态落库。
      // 这样报告层复述状态时不会把无效状态带进最终报告。
      if (
        declared === 'supported' &&
        hypothesis.code !== 'insufficient_evidence' &&
        hypothesis.supporting_evidence_ids.length === 0
      ) {
        return 'inconclusive';
      }
      if (
        declared === 'supported' &&
        hypothesis.contradicting_evidence_ids.length > 0
      ) {
        return 'inconclusive';
      }
      if (
        declared === 'contradicted' &&
        hypothesis.contradicting_evidence_ids.length === 0
      ) {
        return 'inconclusive';
      }
      return declared;
    }
    if (hypothesis.code === 'insufficient_evidence') {
      // 有反证时不能声称“证据不足”已成立；保留为不确定，
      // 但仍作为残余风险进入报告。
      if (hypothesis.contradicting_evidence_ids.length > 0) {
        return 'inconclusive';
      }
      if (handoff || hypothesis.missing_evidence.length > 0) {
        return 'supported';
      }
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
    const declared = new Map(
      drafts
        .filter((draft) => draft.status)
        .map((draft) => [draft.code, draft.status as Hypothesis['status']]),
    );
    const stored = this.options.repo.replaceHypotheses(state.run.id, drafts, {
      leaseToken: state.leaseToken,
      statusFor: (hypothesis) =>
        this.deriveStatus(hypothesis, handoff, declared.get(hypothesis.code)),
    });
    if (!stored) throw new LeaseLostError();
    const updated = stored;
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
      status: hypothesis.status,
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

  /**
   * 报告层只能复述已验证假设。模型改写状态或删掉反证/竞争假设时，
   * 以假设库为准恢复，并记录纠正事件；不改变模型对现象的文字描述。
   */
  private reconcileReportHypotheses(
    state: RunState,
    draftHypotheses: Hypothesis[],
  ): Hypothesis[] {
    const stored = this.options.repo.listHypotheses(state.run.id);
    const byId = new Map(
      stored.map((hypothesis) => [hypothesis.id, hypothesis]),
    );
    const reconciled: Hypothesis[] = [];
    const corrections: Array<{ hypothesis_id: string; fields: string[] }> = [];
    for (const draft of draftHypotheses) {
      const source = byId.get(draft.id);
      if (!source) {
        reconciled.push(draft);
        continue;
      }
      const next: Hypothesis = { ...draft };
      const fields: string[] = [];
      if (next.status !== source.status) {
        next.status = source.status;
        fields.push('status');
      }
      if (
        !sameStringSet(
          next.supporting_evidence_ids,
          source.supporting_evidence_ids,
        )
      ) {
        next.supporting_evidence_ids = [...source.supporting_evidence_ids];
        fields.push('supporting_evidence_ids');
      }
      if (
        !sameStringSet(
          next.contradicting_evidence_ids,
          source.contradicting_evidence_ids,
        )
      ) {
        next.contradicting_evidence_ids = [
          ...source.contradicting_evidence_ids,
        ];
        fields.push('contradicting_evidence_ids');
      }
      if (fields.length > 0) {
        corrections.push({ hypothesis_id: draft.id, fields });
      }
      reconciled.push(next);
    }
    const present = new Set(reconciled.map((hypothesis) => hypothesis.id));
    for (const source of stored) {
      if (present.has(source.id)) continue;
      if (reconciled.length >= 5) break;
      reconciled.push(source);
      corrections.push({
        hypothesis_id: source.id,
        fields: ['added_from_verified'],
      });
    }
    if (corrections.length > 0) {
      state.checkpoint.report_reconciliations = corrections;
      this.emit(state.run.id, 'report.reconciled', { corrections });
      this.persist(state);
    }
    return reconciled;
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
    const hypotheses = this.reconcileReportHypotheses(state, draft.hypotheses);
    const supportedDiagnostic = hypotheses.some(
      (hypothesis) =>
        hypothesis.status === 'supported' &&
        hypothesis.code !== 'insufficient_evidence' &&
        hypothesis.code !== 'unknown',
    );
    const insufficient =
      !supportedDiagnostic &&
      hypotheses.some(
        (hypothesis) => hypothesis.code === 'insufficient_evidence',
      );
    const limitations = [...draft.limitations];
    if (
      state.checkpoint.budget_skipped_final_verify &&
      !limitations.some((item) => /最后一次复核|输出预算/.test(item))
    ) {
      limitations.push(
        '验证阶段的最后一次复核因输出预算保留而跳过；结论基于已入库证据，需人工复核。',
      );
    }
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
      // 有可支持的确定性结论时，报告仍进入人工复核，但不属于“证据不足转人工”。
      // 模型自拟的 handoff_reason 只能作为 next_check/limitations，不能把正常结论标成 handoff。
      handoff_reason:
        handoffReason ?? (supportedDiagnostic ? null : draft.handoff_reason),
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
          kind: 'safety',
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
          kind: 'safety',
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
    const saved = this.options.repo.saveReportFenced(
      state.run.id,
      state.leaseToken,
      report,
      validationSummary(validation),
    );
    if (!saved) throw new LeaseLostError();
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
    if (options.owner) {
      this.options.repo.releaseLease(
        state.run.id,
        options.owner,
        state.leaseToken,
      );
    }
    this.log(
      state.run.id,
      `finished status=awaiting_human conclusion=${report.conclusion_status} handoff=${Boolean(report.handoff_reason)} validation_errors=${validation.errors.length}`,
    );
    return this.options.repo.getRun(state.run.id) ?? state.run;
  }

  private async handoff(
    state: RunState,
    reason: string,
    options: {
      owner?: string;
      error?: string | null;
      signal?: AbortSignal;
    } = {},
  ): Promise<Run> {
    // 取消优先于转人工：不能让 fallback report 把 cancelled 覆盖成
    // awaiting_human，也不能在取消后继续写报告。
    if (
      options.signal?.aborted ||
      this.options.repo.getRun(state.run.id)?.status === 'cancelled'
    ) {
      return await this.finishCancelled(state, options.owner);
    }
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
      documents: this.options.repo.listDocuments(state.run.workspace_id),
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
    if (owner) {
      this.options.repo.releaseLease(state.run.id, owner, state.leaseToken);
    }
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
    if (owner) {
      this.options.repo.releaseLease(state.run.id, owner, state.leaseToken);
    }
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

  /**
   * 找出尚未被任何 supported 诊断假设作为支持证据的异常。
   * 只用于决定是否做一次有界复核，不改变任何状态或证据。
   */
  private unexplainedAnomalies(state: RunState): string[] {
    const hypotheses = this.options.repo.listHypotheses(state.run.id);
    const supportedDiagnostic = hypotheses.filter(
      (hypothesis) =>
        hypothesis.status === 'supported' &&
        hypothesis.code !== 'insufficient_evidence' &&
        hypothesis.code !== 'unknown',
    );
    if (supportedDiagnostic.length > 1) return [];
    const features = deriveTelemetryFeatures(
      this.options.repo.listEvidence(state.run.id),
      this.equipmentSnapshot(state).model,
    );
    return deriveAnomalyLedger(features, hypotheses)
      .filter(
        (item) =>
          item.unexplained && item.flags.some((flag) => flag !== 'quality'),
      )
      .slice(0, 5)
      .map((item) => item.summary);
  }

  private reportOutputReserveAvailable(state: RunState): boolean {
    return (
      state.run.budget.max_output_tokens - state.outputTokens >=
      REPORT_OUTPUT_RESERVE + 400
    );
  }

  private hasSupportedDiagnostic(state: RunState): boolean {
    return this.options.repo
      .listHypotheses(state.run.id)
      .some(
        (hypothesis) =>
          hypothesis.status === 'supported' &&
          hypothesis.code !== 'insufficient_evidence' &&
          hypothesis.code !== 'unknown',
      );
  }

  private isCancellationError(error: unknown): boolean {
    return (
      error instanceof RunCancelledError ||
      (error instanceof RoleRunnerError && error.code === 'CANCELLED')
    );
  }

  /**
   * 取消是终态，不能被预算回退或 handoff 覆盖。若数据库已经是 cancelled，
   * 直接返回当前状态，避免重复事件；若只是 AbortSignal 已触发，则落库为
   * cancelled 后再返回。
   */
  private async finishCancelled(state: RunState, owner?: string): Promise<Run> {
    const fresh = this.options.repo.getRun(state.run.id);
    if (fresh?.status === 'cancelled') {
      state.run = fresh;
      if (owner) {
        this.options.repo.releaseLease(state.run.id, owner, state.leaseToken);
      }
      return fresh;
    }
    return this.cancel(state, owner);
  }

  /** 是否还有足够的总轮次完成 needed 次调用。 */
  private hasRoundReserve(state: RunState, needed: number): boolean {
    return state.totalRounds + needed <= state.run.budget.max_rounds_total;
  }

  private canRunSecondLook(state: RunState): boolean {
    return (
      !state.checkpoint.second_look_done &&
      // 二次复核 + 可能的跟进复核各占一个阶段轮次。
      (state.stageRounds.verify_evidence ?? 0) + 2 <=
        state.run.budget.max_rounds_per_stage &&
      // 二次复核、可能的跟进复核、报告各占一个总轮次。可选动作
      // 不能吃掉报告轮次，否则 runReportStage 会因总轮次超限失败，
      // 而预算回退也使用同一个已耗尽的计数器，无法恢复。
      this.hasRoundReserve(state, 3) &&
      state.modelCalls < state.run.budget.max_model_calls - 2 &&
      // 二次复核是可选动作，不能吃掉报告阶段的输出预留；否则
      // BudgetExceededError 会把已有 supported 根因的 Run 直接转人工。
      this.reportOutputReserveAvailable(state)
    );
  }

  /** 二次复核返回 next_checks 后，是否还能做跟进复核并保留报告轮次。 */
  private canRunVerifyFollowUp(state: RunState): boolean {
    return (
      this.hasRoundReserve(state, 2) &&
      (state.stageRounds.verify_evidence ?? 0) <
        state.run.budget.max_rounds_per_stage &&
      this.reportOutputReserveAvailable(state)
    );
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
    let didFinalCall = false;
    if (
      state.checkpoint.verify_needs_final_call &&
      (!this.reportOutputReserveAvailable(state) ||
        !this.hasRoundReserve(state, 2)) &&
      this.hasSupportedDiagnostic(state)
    ) {
      // 已有可支持结论时，最后一步复核不是必须的；保住报告输出额度，
      // 把未完成的复核写入检查点，由报告限制/人工复核承接。
      delete state.checkpoint.verify_needs_final_call;
      state.checkpoint.second_look_done = true;
      state.checkpoint.budget_skipped_final_verify = true;
      this.persist(state);
      this.log(
        state.run.id,
        'skip final verify to preserve report output reserve',
      );
    }
    if (state.checkpoint.verify_needs_final_call) {
      const focus = this.unexplainedAnomalies(state);
      await this.assertRunnable(state, options.owner, options.signal);
      const output = (await this.callRole(
        state,
        'hypothesis_verifier',
        'verify_evidence',
        {
          signal: options.signal,
          focusAnomalies: focus.length > 0 ? focus : undefined,
        },
      )) as HypothesisVerifierOutput;
      const control = detectControlIntent(state.run.symptom);
      this.storeHypotheses(state, output.hypotheses, control);
      delete state.checkpoint.verify_needs_final_call;
      state.checkpoint.second_look_done = true;
      didFinalCall = true;
      this.persist(state);
    }

    if (!didFinalCall && this.canRunSecondLook(state)) {
      const focus = this.unexplainedAnomalies(state);
      if (focus.length > 0) {
        state.checkpoint.second_look_done = true;
        this.persist(state);
        await this.assertRunnable(state, options.owner, options.signal);
        const output = (await this.callRole(
          state,
          'hypothesis_verifier',
          'verify_evidence',
          { signal: options.signal, focusAnomalies: focus },
        )) as HypothesisVerifierOutput;
        const control = detectControlIntent(state.run.symptom);
        this.storeHypotheses(state, output.hypotheses, control);
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
          if (this.canRunVerifyFollowUp(state)) {
            await this.assertRunnable(state, options.owner, options.signal);
            const finalOutput = (await this.callRole(
              state,
              'hypothesis_verifier',
              'verify_evidence',
              { signal: options.signal, focusAnomalies: focus },
            )) as HypothesisVerifierOutput;
            this.storeHypotheses(state, finalOutput.hypotheses, control);
          } else {
            state.checkpoint.budget_skipped_final_verify = true;
            this.persist(state);
            this.log(
              state.run.id,
              'skip optional second-look final verify to preserve report round/output reserve',
            );
          }
        }
        this.persist(state);
      }
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
    if (diagnostic.length === 0 && insufficient) {
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
    // 有可支持的诊断假设时继续生成报告；模型同时列出低置信度
    // insufficient_evidence 只作为残余不确定性，不覆盖已支持的根因。
    // 只有没有任何可支持诊断假设时才走兜底转人工报告。
    if (diagnostic.length === 0) return 'handoff';
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
      if (options.owner) {
        this.options.repo.releaseLease(
          state.run.id,
          options.owner,
          state.leaseToken,
        );
      }
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
      documents: this.options.repo.listDocuments(state.run.workspace_id),
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
      try {
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
          documents: this.options.repo.listDocuments(state.run.workspace_id),
          toolCalls: this.options.repo
            .listToolCalls(state.run.id)
            .map((row) => ({
              tool: String(row.tool),
              status: String(row.status),
              policy_decision: String(row.policy_decision),
              error_code: (row.error_code as string | null) ?? null,
            })),
        });
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        // 报告初稿已生成；没有轮次/输出额度做修复时，保留初稿并按
        // 校验失败进入人工复核，不能因可选修复把整个 Run 转人工。
        this.log(
          state.run.id,
          `skip report repair after budget exhaustion: ${error.message}`,
        );
      }
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
    options: { owner?: string; signal?: AbortSignal; leaseToken?: number } = {},
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
    let leaseToken = options.leaseToken ?? run.lease_token;
    if (run.status === 'queued') {
      if (options.owner) {
        const claimed = this.options.repo.claimRun(
          runId,
          options.owner,
          this.options.leaseMs ?? 60_000,
        );
        if (claimed === null) {
          return this.options.repo.getRun(runId) ?? run;
        }
        leaseToken = claimed;
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
    // 上次进程可能在“请求已发出、回执未落库”之间崩溃。恢复时把遗留的
    // inflight 调用标记为 unknown，而不是成功或未执行；随后各阶段按检查点
    // 重新检索，证据使用确定性 ID 去重。
    const recoveredCalls = this.options.repo.markInflightToolCallsFenced(
      runId,
      leaseToken,
      'RECEIPT_UNKNOWN',
    );
    for (const call of recoveredCalls) {
      this.emit(runId, 'tool.finished', {
        logical_call_id: call.logical_call_id,
        status: 'unknown',
        error_code: 'RECEIPT_UNKNOWN',
        recovered: true,
      });
    }
    const fresh = this.options.repo.getRun(runId)!;
    const state: RunState = {
      run: fresh,
      leaseToken,
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
      withdrawnDocuments: this.withdrawnDocuments(
        state.run.workspace_id,
        scenarioId,
      ),
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
            { owner: options.owner, signal: options.signal },
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
          { owner: options.owner, signal: options.signal },
        );
      }
      return finalRun;
    } catch (error) {
      if (error instanceof AlreadyFinishedError) {
        return this.options.repo.getRun(runId) ?? state.run;
      }
      if (error instanceof RunCancelledError) {
        return await this.finishCancelled(state, options.owner);
      }
      if (error instanceof LeaseLostError) {
        this.log(runId, 'lease lost; another worker owns the run');
        return this.options.repo.getRun(runId) ?? state.run;
      }
      if (error instanceof BudgetExceededError) {
        if (
          options.signal?.aborted ||
          this.options.repo.getRun(runId)?.status === 'cancelled'
        ) {
          return await this.finishCancelled(state, options.owner);
        }
        // 验证阶段的修复调用可能耗尽“报告预留之外”的输出额度。若已有
        // supported 诊断假设，报告阶段本身仍可使用预留额度；此时不应把
        // 一个已有可核查结论的 Run 直接转人工。报告仍进入人工复核，并把
        // 跳过的最后复核写入 limitations。
        const remainingOutput =
          state.run.budget.max_output_tokens - state.outputTokens;
        if (
          state.stage !== 'produce_report' &&
          remainingOutput > 0 &&
          state.totalRounds < state.run.budget.max_rounds_total &&
          this.hasSupportedDiagnostic(state)
        ) {
          const from = state.stage;
          state.stage = 'produce_report';
          state.checkpoint.budget_skipped_final_verify = true;
          this.persist(state);
          this.emit(runId, 'stage.changed', {
            from,
            to: 'produce_report',
            reason: 'budget_fallback',
          });
          this.log(
            runId,
            `budget exhausted during ${from}; generating report with supported hypotheses`,
          );
          try {
            await this.runReportStage(state, options);
            return this.options.repo.getRun(runId) ?? state.run;
          } catch (reportError) {
            if (
              this.isCancellationError(reportError) ||
              options.signal?.aborted ||
              this.options.repo.getRun(runId)?.status === 'cancelled'
            ) {
              this.log(
                runId,
                'report fallback was cancelled; preserving cancelled state',
              );
              return await this.finishCancelled(state, options.owner);
            }
            this.log(
              runId,
              `report fallback after budget error failed: ${failureText(reportError)}`,
            );
          }
        }
        return await this.handoff(state, error.message, {
          owner: options.owner,
          signal: options.signal,
        });
      }
      if (error instanceof RoleRunnerError && error.code === 'CANCELLED') {
        return await this.finishCancelled(state, options.owner);
      }
      if (error instanceof RoleRunnerError && error.code === 'UNCONFIGURED') {
        return await this.handoff(state, error.message, {
          owner: options.owner,
          error: error.message,
          signal: options.signal,
        });
      }
      return await this.fail(state, error, options.owner);
    } finally {
      await mcp.close();
    }
  }
}
