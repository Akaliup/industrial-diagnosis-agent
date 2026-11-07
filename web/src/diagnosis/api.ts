import type {
  Alarm,
  Approval,
  DiagnosisSource,
  Evidence,
  Report,
  Review,
  Run,
  RunEvent,
} from './contracts.generated';

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
}

export class DiagnosisApiError extends Error implements ApiFailure {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DiagnosisApiError';
  }
}

function redirectToLogin(): void {
  if (window.location.hash.startsWith('#/login')) return;
  const base = window.location.pathname.startsWith('/diagnosis')
    ? '/diagnosis'
    : window.location.pathname.replace(/diagnosis\.html$/, 'diagnosis.html');
  window.location.href = `${base}#/login`;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  options2: { auth?: boolean } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers,
  });
  if (response.status === 401 && options2.auth !== false) {
    redirectToLogin();
    throw new DiagnosisApiError(401, 'UNAUTHORIZED', '登录已过期');
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const error = (
      body as {
        error?: string | { code?: string; message?: string };
      }
    )?.error;
    const code = typeof error === 'object' ? error?.code : undefined;
    const message =
      typeof error === 'string'
        ? error
        : (error?.message ?? `请求失败（HTTP ${response.status}）`);
    throw new DiagnosisApiError(response.status, code ?? 'HTTP_ERROR', message);
  }
  return body as T;
}

function qs(
  params: Record<string, string | number | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface AuthUser {
  id: string;
  username: string;
  display_name: string | null;
  role: 'admin' | 'member';
  status: string;
  permissions: string[];
  must_change_password?: boolean;
}

export interface RunView extends Run {
  scenario_id?: string | null;
}

export interface RunDetail {
  run: RunView;
  report: Report | null;
  validation: {
    valid: boolean;
    errors: number;
    warnings: number;
    issues: Array<{ code: string; message: string }>;
  } | null;
  hypotheses: Array<{
    id: string;
    code: string;
    title: string;
    description: string;
    status: string;
    confidence: string;
    rationale: string;
    supporting_evidence_ids: string[];
    contradicting_evidence_ids: string[];
    missing_evidence: string[];
    next_check: string | null;
  }>;
  evidence: Evidence[];
  tool_calls: Array<Record<string, unknown>>;
  events: RunEvent[];
  reviews: Review[];
  context_manifests: Array<Record<string, unknown>>;
}

export interface AlarmView extends Alarm {
  scenario_id: string | null;
}

export interface EquipmentView {
  equipment_id: string;
  name: string;
  vendor: string;
  model: string;
  serial: string;
  asset_category: string;
  manual_document_id: string | null;
  manual_version: string | null;
  source_ids: Record<string, string>;
  metrics: Record<string, { unit: string; normal_range: [number, number] }>;
}

export interface DocumentView {
  document_id: string;
  title: string;
  vendor: string;
  model: string;
  manual_version: string;
  effective_date: string | null;
  file_hash: string;
  file_path: string;
  parser_version: string;
  status: string;
  withdrawn_at?: string | null;
}

export interface MetaView {
  workspace_id: string;
  model_mode: 'fixture' | 'live';
  data_mode: 'mock' | 'replay' | 'live';
  fts_tokenizer: string | null;
  live_eval: string;
  control_execution: 'disabled';
  demo_scenarios: string[];
}

export const authApi = {
  status: () =>
    request<{ initialized: boolean }>('/api/auth/status', {}, { auth: false }),
  me: () => request<{ user: AuthUser }>('/api/auth/me', {}, { auth: false }),
  setup: (username: string, password: string) =>
    request<{ success: boolean; user: AuthUser }>(
      '/api/auth/setup',
      {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      },
      { auth: false },
    ),
  login: (username: string, password: string) =>
    request<{ user: AuthUser }>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      },
      { auth: false },
    ),
  logout: () =>
    request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
};

export const diagnosisApi = {
  meta: (workspaceId?: string) =>
    request<MetaView>(
      `/api/diagnosis/meta${qs({ workspace_id: workspaceId })}`,
    ),
  demoSeed: (workspaceId?: string) =>
    request<{
      workspace_id: string;
      seed: Record<string, number>;
      demo_alarms: AlarmView[];
    }>('/api/diagnosis/demo/seed', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),
  alarms: (params: {
    workspace_id?: string;
    state?: string;
    severity?: string;
    equipment_id?: string;
  }) => request<{ alarms: AlarmView[] }>(`/api/diagnosis/alarms${qs(params)}`),
  alarm: (id: string, workspaceId?: string) =>
    request<{
      alarm: AlarmView;
      equipment: EquipmentView | null;
      runs: RunView[];
    }>(
      `/api/diagnosis/alarms/${encodeURIComponent(id)}${qs({ workspace_id: workspaceId })}`,
    ),
  equipment: (workspaceId?: string) =>
    request<{ equipment: EquipmentView[] }>(
      `/api/diagnosis/equipment${qs({ workspace_id: workspaceId })}`,
    ),
  equipmentDetail: (id: string, workspaceId?: string) =>
    request<{
      equipment: EquipmentView;
      alarms: AlarmView[];
      runs: RunView[];
      sources: DiagnosisSource[];
    }>(
      `/api/diagnosis/equipment/${encodeURIComponent(id)}${qs({ workspace_id: workspaceId })}`,
    ),
  runs: (params: {
    workspace_id?: string;
    status?: string;
    equipment_id?: string;
    limit?: number;
  }) => request<{ runs: RunView[] }>(`/api/diagnosis/runs${qs(params)}`),
  run: (id: string, workspaceId?: string) =>
    request<RunDetail>(
      `/api/diagnosis/runs/${encodeURIComponent(id)}${qs({ workspace_id: workspaceId })}`,
    ),
  createRun: (body: {
    workspace_id?: string;
    alarm_id?: string;
    equipment_id: string;
    window: { start: string; end: string };
    symptom: string;
  }) =>
    request<{ run: RunView; created: boolean }>('/api/diagnosis/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancelRun: (id: string, workspaceId?: string) =>
    request<{ run: RunView; cancelled: boolean }>(
      `/api/diagnosis/runs/${encodeURIComponent(id)}/cancel${qs({ workspace_id: workspaceId })}`,
      { method: 'POST' },
    ),
  resumeRun: (id: string, note: string, workspaceId?: string) =>
    request<{ run: RunView; resumed_from: string }>(
      `/api/diagnosis/runs/${encodeURIComponent(id)}/resume${qs({ workspace_id: workspaceId })}`,
      { method: 'POST', body: JSON.stringify({ note }) },
    ),
  events: (id: string, afterSeq: number, workspaceId?: string) =>
    request<{ events: RunEvent[] }>(
      `/api/diagnosis/runs/${encodeURIComponent(id)}/events${qs({
        after_seq: afterSeq,
        workspace_id: workspaceId,
      })}`,
    ),
  evidence: (runId: string, evidenceId: string, workspaceId?: string) =>
    request<{ evidence: Evidence; document: DocumentView | null }>(
      `/api/diagnosis/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(
        evidenceId,
      )}${qs({ workspace_id: workspaceId })}`,
    ),
  reportMarkdownUrl: (runId: string, workspaceId?: string) =>
    `/api/diagnosis/runs/${encodeURIComponent(runId)}/report${qs({
      format: 'markdown',
      workspace_id: workspaceId,
    })}`,
  reportHtmlUrl: (runId: string, workspaceId?: string) =>
    `/api/diagnosis/runs/${encodeURIComponent(runId)}/report${qs({
      format: 'html',
      workspace_id: workspaceId,
    })}`,
  reviews: (runId: string, workspaceId?: string) =>
    request<{ reviews: Review[] }>(
      `/api/diagnosis/runs/${encodeURIComponent(runId)}/reviews${qs({
        workspace_id: workspaceId,
      })}`,
    ),
  submitReview: (
    runId: string,
    body: {
      workspace_id?: string;
      decision: 'accepted' | 'rejected';
      comment: string;
      observations: string[];
    },
  ) =>
    request<{ review: Review }>(
      `/api/diagnosis/runs/${encodeURIComponent(runId)}/reviews`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  approvals: (params: { workspace_id?: string; status?: string }) =>
    request<{ approvals: Approval[]; control_execution: string }>(
      `/api/diagnosis/approvals${qs(params)}`,
    ),
  createApproval: (
    runId: string,
    body: {
      workspace_id?: string;
      action_id: string;
      risk_level: 'read' | 'knowledge_read' | 'control_intent' | 'control';
      params: Record<string, unknown>;
    },
  ) =>
    request<{ approval: Approval; control_execution: string; message: string }>(
      `/api/diagnosis/runs/${encodeURIComponent(runId)}/approvals`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  decideApproval: (
    id: string,
    decision: 'approved' | 'rejected',
    workspaceId?: string,
  ) =>
    request<{ approval: Approval; control_execution: string; message: string }>(
      `/api/diagnosis/approvals/${encodeURIComponent(id)}/decision${qs({
        workspace_id: workspaceId,
      })}`,
      { method: 'POST', body: JSON.stringify({ decision }) },
    ),
  sources: (workspaceId?: string) =>
    request<{ sources: DiagnosisSource[]; workspace_id: string }>(
      `/api/diagnosis/sources${qs({ workspace_id: workspaceId })}`,
    ),
  testSource: (id: string, workspaceId?: string) =>
    request<{ ok: boolean; mode: string; message: string; code?: string }>(
      `/api/diagnosis/sources/${encodeURIComponent(id)}/test${qs({
        workspace_id: workspaceId,
      })}`,
      { method: 'POST' },
    ),
  addSource: (body: {
    workspace_id?: string;
    id: string;
    kind: string;
    name: string;
    data_mode: 'mock' | 'replay' | 'live';
    auth_kind: string;
    notes: string;
  }) =>
    request<{ source: DiagnosisSource }>('/api/diagnosis/sources', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  importDocument: (body: {
    workspace_id?: string;
    document_id: string;
    file_path: string;
    title: string;
    vendor: string;
    model: string;
    manual_version: string;
    effective_date?: string | null;
  }) =>
    request<{
      result: {
        documentId: string;
        status: string;
        chunks: number;
        pages: number;
        error?: string;
      };
    }>('/api/diagnosis/documents/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  documents: (workspaceId?: string) =>
    request<{ documents: DocumentView[]; fts_tokenizer: string | null }>(
      `/api/diagnosis/documents${qs({ workspace_id: workspaceId })}`,
    ),
  withdrawDocument: (id: string, workspaceId?: string) =>
    request<{ ok: boolean }>(
      `/api/diagnosis/documents/${encodeURIComponent(id)}/withdraw${qs({
        workspace_id: workspaceId,
      })}`,
      { method: 'POST' },
    ),
  documentUrl: (id: string, workspaceId?: string) =>
    `/api/diagnosis/documents/${encodeURIComponent(id)}/file${qs({
      workspace_id: workspaceId,
    })}`,
  evalRuns: () =>
    request<{ eval_runs: Array<Record<string, unknown>> }>(
      '/api/diagnosis/eval-runs',
    ),
  evalRun: (id: string) =>
    request<{ eval_run: Record<string, unknown> }>(
      `/api/diagnosis/eval-runs/${encodeURIComponent(id)}`,
    ),
  startEval: (body: {
    split: 'dev' | 'holdout' | 'all';
    limit?: number | null;
  }) =>
    request<{
      eval_run_id: string;
      status: string;
      split: string;
      traces: string;
    }>('/api/diagnosis/eval-runs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  trace: (evalRunId: string, caseId: string) =>
    request<Record<string, unknown>>(
      `/api/diagnosis/eval-runs/${encodeURIComponent(
        evalRunId,
      )}/traces/${encodeURIComponent(caseId)}`,
    ),
};
