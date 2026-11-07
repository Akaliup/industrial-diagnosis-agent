import {
  EvidenceGetInputSchema,
  type DataMode,
  type ErrorCode,
  type Evidence,
  type EvidenceDraft,
  type Role,
  type Run,
  type ToolError,
  type ToolResponseEnvelope,
  type ToolResult,
  type Window,
} from './contracts/domain.js';
import type { DiagnosisEventBus } from './events.js';
import type { KnowledgeService } from './knowledge.js';
import type { CallAttempt, DiagnosisMcpClient } from './mcp-client.js';
import { checkToolPolicy, toolFamily } from './policy.js';
import { RepeatGuard } from './repeat-guard.js';
import type { DiagnosisRepository } from './repository.js';
import { newId, nowIso, sha256, canonicalJson } from './util.js';
import type { QueryRequest } from './contracts/domain.js';

export interface GatewayDeps {
  repo: DiagnosisRepository;
  knowledge: KnowledgeService;
  mcp: DiagnosisMcpClient;
  repeatGuard: RepeatGuard;
  bus: DiagnosisEventBus;
}

export interface GatewayInput {
  run: Run;
  role: Role;
  request: QueryRequest;
  stageRound: number;
  logicalCalls: number;
  signal?: AbortSignal;
  sourceAllowlist: string[] | null;
  scenarioId: string | null;
  withdrawnDocuments?: string[];
}

export interface GatewayOutcome {
  ok: boolean;
  envelope: ToolResponseEnvelope;
  newEvidence: Evidence[];
  logicalCallId: string;
  attempts: number;
  policyDecision: string;
  error?: ToolError;
}

function emptyCoverage(
  window: Window,
  missing: string[] = [],
): {
  from: string;
  to: string;
  complete: boolean;
  missing: string[];
} {
  return { from: window.start, to: window.end, complete: false, missing };
}

function makeEnvelope(input: {
  dataMode: DataMode;
  window: Window;
  status: ToolResponseEnvelope['status'];
  data: unknown;
  evidence: EvidenceDraft[];
  warnings: ToolResponseEnvelope['warnings'];
  error: ToolError | null;
  logicalCallId: string;
  nextCursor?: string | null;
}): ToolResponseEnvelope {
  return {
    schema_version: '1',
    request_id: newId('req'),
    logical_call_id: input.logicalCallId,
    data_mode: input.dataMode,
    status: input.status,
    data: input.data ?? null,
    evidence: input.evidence,
    coverage: emptyCoverage(
      input.window,
      input.error ? [input.error.code] : [],
    ),
    warnings: input.warnings,
    error: input.error,
    next_cursor: input.nextCursor ?? null,
  };
}

function fromToolResult<T>(
  result: ToolResult<T>,
  dataMode: DataMode,
  window: Window,
  logicalCallId: string,
): ToolResponseEnvelope {
  return {
    schema_version: '1',
    request_id: newId('req'),
    logical_call_id: logicalCallId,
    data_mode: dataMode,
    status: result.status,
    data: result.data,
    evidence: result.evidence,
    coverage: result.coverage,
    warnings: result.warnings,
    error: result.error,
    next_cursor: result.next_cursor,
  };
}

export class ToolGateway {
  constructor(private readonly deps: GatewayDeps) {}

  private recordCall(input: {
    runId: string;
    logicalCallId: string;
    attempt: number;
    tool: string;
    role: Role;
    args: unknown;
    status: string;
    errorCode: string | null;
    durationMs: number;
    evidenceCount: number;
    policyDecision: string;
    startedAt: string;
  }): void {
    this.deps.repo.recordToolCall({
      id: newId('call'),
      runId: input.runId,
      logicalCallId: input.logicalCallId,
      attempt: input.attempt,
      tool: input.tool,
      role: input.role,
      args: input.args,
      argsHash: sha256(canonicalJson(input.args)),
      status: input.status,
      errorCode: input.errorCode,
      durationMs: input.durationMs,
      evidenceCount: input.evidenceCount,
      policyDecision: input.policyDecision,
      startedAt: input.startedAt,
      finishedAt: nowIso(),
    });
  }

  private ingest(
    run: Run,
    drafts: EvidenceDraft[],
  ): {
    evidence: Evidence[];
    newEvidence: Evidence[];
    warnings: ToolResponseEnvelope['warnings'];
  } {
    const evidence: Evidence[] = [];
    const newEvidence: Evidence[] = [];
    const warnings: ToolResponseEnvelope['warnings'] = [];
    for (const draft of drafts) {
      if (draft.workspace_id !== run.workspace_id || draft.run_id !== run.id) {
        warnings.push({
          code: 'EVIDENCE_SCOPE_MISMATCH',
          message: `丢弃作用域不匹配的证据 ${draft.id}`,
        });
        continue;
      }
      const ingested = this.deps.repo.ingestEvidence(draft);
      evidence.push(ingested.evidence);
      if (ingested.isNew) {
        newEvidence.push(ingested.evidence);
        this.deps.bus.publish(
          this.deps.repo.appendEvent(run.id, 'evidence.added', {
            evidence_id: ingested.evidence.id,
            source_kind: ingested.evidence.source_kind,
            summary: ingested.evidence.payload.kind,
          }),
        );
      }
    }
    return { evidence, newEvidence, warnings };
  }

  async execute(input: GatewayInput): Promise<GatewayOutcome> {
    const { run, role, request } = input;
    const logicalCallId = newId('lc');
    const startedAt = nowIso();
    const decision = checkToolPolicy({
      role,
      tool: request.tool,
      args: request.args,
      run,
      stageRound: input.stageRound,
      logicalCalls: input.logicalCalls,
    });
    if (!decision.allowed) {
      this.recordCall({
        runId: run.id,
        logicalCallId,
        attempt: 1,
        tool: request.tool,
        role,
        args: request.args,
        status: 'denied',
        errorCode: decision.code ?? 'POLICY_DENIED',
        durationMs: 0,
        evidenceCount: 0,
        policyDecision: decision.reason,
        startedAt,
      });
      const error: ToolError = {
        code: decision.code ?? 'POLICY_DENIED',
        retryable: false,
        safe_message: decision.message ?? '策略拒绝',
      };
      return {
        ok: false,
        envelope: makeEnvelope({
          dataMode: run.data_mode,
          window: run.window,
          status: 'error',
          data: null,
          evidence: [],
          warnings: [],
          error,
          logicalCallId,
        }),
        newEvidence: [],
        logicalCallId,
        attempts: 0,
        policyDecision: decision.reason,
        error,
      };
    }

    const key = this.deps.repeatGuard.key(
      request.tool,
      request.args,
      `${run.workspace_id}|${run.id}|${run.equipment_id}`,
      input.scenarioId ?? 'base',
    );
    const repeat = this.deps.repeatGuard.check(key);
    if (repeat.action === 'rejected') {
      this.recordCall({
        runId: run.id,
        logicalCallId,
        attempt: 1,
        tool: request.tool,
        role,
        args: request.args,
        status: 'rejected',
        errorCode: 'REPEATED_CALL',
        durationMs: 0,
        evidenceCount: 0,
        policyDecision: 'repeated',
        startedAt,
      });
      const error: ToolError = {
        code: 'REPEATED_CALL',
        retryable: false,
        safe_message: repeat.message ?? '重复调用被拒绝',
      };
      const cached = repeat.cached;
      return {
        ok: false,
        envelope: makeEnvelope({
          dataMode: run.data_mode,
          window: run.window,
          status: 'error',
          data: null,
          evidence: cached?.evidence ?? [],
          warnings: [
            {
              code: 'REPEATED_CALL',
              message: error.safe_message,
            },
          ],
          error,
          logicalCallId,
        }),
        newEvidence: [],
        logicalCallId,
        attempts: 0,
        policyDecision: 'repeated',
        error,
      };
    }
    if (repeat.action === 'cached' && repeat.cached) {
      this.recordCall({
        runId: run.id,
        logicalCallId,
        attempt: 1,
        tool: request.tool,
        role,
        args: request.args,
        status: 'cached',
        errorCode: null,
        durationMs: 0,
        evidenceCount: repeat.cached.evidence.length,
        policyDecision: 'cached',
        startedAt,
      });
      const envelope: ToolResponseEnvelope = {
        ...repeat.cached,
        logical_call_id: logicalCallId,
        warnings: [
          ...repeat.cached.warnings,
          { code: 'CACHED_RESULT', message: '相同参数已查询过，复用缓存结果' },
        ],
      };
      return {
        ok: envelope.status !== 'error',
        envelope,
        newEvidence: [],
        logicalCallId,
        attempts: 0,
        policyDecision: 'cached',
        error: envelope.error ?? undefined,
      };
    }

    let envelope: ToolResponseEnvelope;
    let attempts = 1;
    if (request.tool === 'evidence_get') {
      const parsed = EvidenceGetInputSchema.parse(request.args);
      const found = this.deps.repo.listEvidence(run.id, parsed.evidence_ids);
      const missing = parsed.evidence_ids.filter(
        (id) => !found.some((e) => e.id === id),
      );
      const result: ToolResult<{ evidence: Evidence[] }> = {
        status:
          found.length === 0
            ? 'no_data'
            : missing.length > 0
              ? 'partial'
              : 'success',
        data: found.length > 0 ? { evidence: found } : null,
        evidence: [],
        coverage: emptyCoverage(run.window, missing),
        warnings: missing.map((id) => ({
          code: 'EVIDENCE_NOT_FOUND',
          message: `证据 ${id} 不属于当前 Run`,
        })),
        error: null,
        next_cursor: null,
      };
      envelope = fromToolResult(
        result,
        run.data_mode,
        run.window,
        logicalCallId,
      );
      this.recordCall({
        runId: run.id,
        logicalCallId,
        attempt: 1,
        tool: request.tool,
        role,
        args: request.args,
        status: envelope.status,
        errorCode: null,
        durationMs: 0,
        evidenceCount: 0,
        policyDecision: 'allowed',
        startedAt,
      });
    } else if (
      toolFamily(request.tool) === 'manual' ||
      toolFamily(request.tool) === 'cases'
    ) {
      const ctx = {
        workspaceId: run.workspace_id,
        runId: run.id,
        dataMode: run.data_mode,
        query: request.args,
        withdrawnDocuments: input.withdrawnDocuments,
      };
      let result: ToolResult<unknown>;
      if (request.tool === 'maintenance_search_manual') {
        result = this.deps.knowledge.searchManual(request.args as never, ctx);
      } else if (request.tool === 'maintenance_get_manual_section') {
        result = this.deps.knowledge.getManualSection(
          request.args as never,
          ctx,
        );
      } else {
        result = this.deps.knowledge.searchCases(request.args as never, ctx);
      }
      envelope = fromToolResult(
        result,
        run.data_mode,
        run.window,
        logicalCallId,
      );
      const ingested = this.ingest(run, envelope.evidence);
      envelope.evidence = ingested.evidence;
      envelope.warnings = [...envelope.warnings, ...ingested.warnings];
      this.recordCall({
        runId: run.id,
        logicalCallId,
        attempt: 1,
        tool: request.tool,
        role,
        args: request.args,
        status: envelope.status,
        errorCode: envelope.error?.code ?? null,
        durationMs: 0,
        evidenceCount: ingested.newEvidence.length,
        policyDecision: 'allowed',
        startedAt,
      });
      this.deps.repeatGuard.record(key, envelope);
      return {
        ok: envelope.status !== 'error',
        envelope,
        newEvidence: ingested.newEvidence,
        logicalCallId,
        attempts: 1,
        policyDecision: 'allowed',
        error: envelope.error ?? undefined,
      };
    } else {
      const result = await this.deps.mcp.callWithRetry(
        request.tool,
        request.args,
        run.window,
        {
          signal: input.signal,
          timeoutMs: run.budget.source_timeout_ms,
          maxAttempts: run.budget.max_attempts_per_call,
          onAttempt: (attempt: CallAttempt) => {
            this.recordCall({
              runId: run.id,
              logicalCallId,
              attempt: attempt.attempt,
              tool: request.tool,
              role,
              args: request.args,
              status: attempt.envelope.status,
              errorCode: attempt.envelope.error?.code ?? null,
              durationMs: attempt.durationMs,
              evidenceCount: attempt.envelope.evidence.length,
              policyDecision: 'allowed',
              startedAt,
            });
          },
        },
      );
      envelope = {
        ...result.envelope,
        logical_call_id: logicalCallId,
      };
      attempts = result.attempts;
      const ingested = this.ingest(run, envelope.evidence);
      envelope.evidence = ingested.evidence;
      envelope.warnings = [...envelope.warnings, ...ingested.warnings];
      this.deps.repeatGuard.record(key, envelope);
      return {
        ok: envelope.status !== 'error',
        envelope,
        newEvidence: ingested.newEvidence,
        logicalCallId,
        attempts,
        policyDecision: 'allowed',
        error: envelope.error ?? undefined,
      };
    }

    const ingested = this.ingest(run, envelope.evidence);
    envelope.evidence = ingested.evidence;
    envelope.warnings = [...envelope.warnings, ...ingested.warnings];
    this.deps.repeatGuard.record(key, envelope);
    return {
      ok: envelope.status !== 'error',
      envelope,
      newEvidence: ingested.newEvidence,
      logicalCallId,
      attempts,
      policyDecision: 'allowed',
      error: envelope.error ?? undefined,
    };
  }
}

export function policyErrorCode(value: string): ErrorCode {
  return value as ErrorCode;
}
