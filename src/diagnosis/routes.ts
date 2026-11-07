import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import {
  getUserHomeGroup,
  ensureUserHomeGroup,
  getRegisteredGroup,
} from '../db.js';
import { hasPermission } from '../permissions.js';
import { canAccessGroup, type Variables } from '../web-context.js';
import type { AuthUser, UserRole } from '../types.js';
import {
  DEFAULT_BUDGET,
  WindowSchema,
  type DataMode,
  type ModelMode,
  type Report,
  type Run,
  type RunEventType,
} from './contracts/domain.js';
import type { DiagnosisRuntime } from './runtime.js';
import { seedDemoWorkspace } from './demo.js';
import { EvalNotRunError, evalTracePath, runEvalSuite } from './eval-runner.js';
import { aggregateMetrics } from './eval.js';
import { liveSourcesReady, testLiveSource } from './source-health.js';
import {
  approvalExpired,
  CONTROL_EXECUTION,
  selfApprovalForbidden,
} from './approval-policy.js';
import {
  canonicalJson,
  newId,
  nowIso,
  sha256,
  stableScopedId,
} from './util.js';

const DEMO_SCENARIOS = [
  'demo-sensor-drift',
  'demo-bearing-wear',
  'demo-false-alarm-comm',
  'demo-multi-fault',
  'demo-source-timeout',
] as const;

type DiagnosisEnv = { Variables: Variables };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function userOf(c: { get: (key: 'user') => unknown }): AuthUser {
  const user = c.get('user') as AuthUser | undefined;
  if (!user) fail(401, 'UNAUTHORIZED', '需要登录');
  return user;
}

function isAdmin(user: AuthUser): boolean {
  return user.role === 'admin' || hasPermission(user, 'manage_system_config');
}

function requireAdmin(user: AuthUser): void {
  if (!isAdmin(user)) fail(403, 'FORBIDDEN', '需要管理员权限');
}

function resolveWorkspace(user: AuthUser, requested?: string | null): string {
  const explicit = requested?.trim();
  if (explicit) {
    const group = getRegisteredGroup(explicit);
    if (!group || !canAccessGroup(user, group)) {
      fail(404, 'WORKSPACE_NOT_FOUND', '工作区不存在或无权访问');
    }
    return explicit;
  }
  const home = getUserHomeGroup(user.id);
  if (home) return home.jid;
  return ensureUserHomeGroup(
    user.id,
    user.role as Extract<UserRole, 'admin' | 'member'>,
    user.username,
  );
}

async function readBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, 'INVALID_JSON', '请求体不是合法 JSON');
  }
}

function parseOrFail<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    fail(
      400,
      'VALIDATION_ERROR',
      `${first?.path.join('.') || 'body'}: ${first?.message ?? '参数不合法'}`,
    );
  }
  return parsed.data;
}

function eventOf(
  runtime: DiagnosisRuntime,
  runId: string,
  type: RunEventType,
  payload: Record<string, unknown> = {},
): void {
  const event = runtime.repo.appendEvent(runId, type, payload);
  runtime.bus.publish(event);
}

function runView(runtime: DiagnosisRuntime, run: Run): Record<string, unknown> {
  return {
    ...run,
    scenario_id: runtime.repo.getRunScenario(run.id),
  };
}

function currentReport(runtime: DiagnosisRuntime, run: Run): Report | null {
  const record = runtime.repo.getReport(run.id);
  if (!record) return null;
  // 报告生成时的 review_status 是快照；人工复核后以 Run 的当前状态为准，
  // 否则导出的报告会永远停留在 pending。
  return {
    ...record.report,
    review_status: run.review_status,
    conclusion_status: run.conclusion_status,
  };
}

function runDetail(
  runtime: DiagnosisRuntime,
  run: Run,
): Record<string, unknown> {
  const reportRecord = runtime.repo.getReport(run.id);
  return {
    run: runView(runtime, run),
    report: currentReport(runtime, run),
    validation: reportRecord?.validation ?? null,
    hypotheses: runtime.repo.listHypotheses(run.id),
    evidence: runtime.repo.listEvidence(run.id),
    tool_calls: runtime.repo.listToolCalls(run.id),
    events: runtime.repo.listEvents(run.id, 0, 500),
    reviews: runtime.repo.listReviews(run.id),
    context_manifests: runtime.repo.listManifests(run.id),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function reportToMarkdown(report: Report): string {
  const lines: string[] = [
    `# 设备诊断报告 ${report.run_id}`,
    '',
    `- 设备：${report.equipment_snapshot.name}（${report.equipment_snapshot.model} / ${report.equipment_snapshot.serial}）`,
    `- 数据模式：${report.data_mode}`,
    `- 模型模式：${report.model_mode}`,
    `- 结论状态：${report.conclusion_status}`,
    `- 人工复核：${report.review_status}`,
    `- 生成时间：${report.as_of}`,
    '',
    '## 报警',
    '',
    `- ${report.alarm_context.code} / ${report.alarm_context.severity}：${report.alarm_context.message}`,
    '',
    '## 观察',
    '',
  ];
  for (const observation of report.observations) {
    lines.push(`- ${observation.text}`);
  }
  lines.push('', '## 候选根因', '');
  for (const hypothesis of report.hypotheses) {
    lines.push(
      `- [${hypothesis.status}] ${hypothesis.code}：${hypothesis.title}。${hypothesis.description}`,
    );
    lines.push(
      `  - 支持证据：${hypothesis.supporting_evidence_ids.join(', ') || '无'}`,
    );
    lines.push(
      `  - 反证：${hypothesis.contradicting_evidence_ids.join(', ') || '无'}`,
    );
    lines.push(`  - 缺口：${hypothesis.missing_evidence.join('、') || '无'}`);
  }
  lines.push('', '## 检查项', '');
  for (const check of report.checks) {
    lines.push(
      `- ${check.purpose}（风险 ${check.risk}，需人工：${check.requires_human ? '是' : '否'}）`,
    );
    lines.push(`  - 步骤：${check.steps.join(' → ')}`);
  }
  lines.push('', '## 建议', '');
  for (const recommendation of report.recommendations) {
    lines.push(
      `- ${recommendation.text}（控制执行：${recommendation.control_execution}）`,
    );
  }
  lines.push('', '## 限制与未解决问题', '');
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  for (const question of report.unresolved_questions) {
    lines.push(`- ${question}`);
  }
  if (report.handoff_reason) {
    lines.push('', '## 转人工原因', '', report.handoff_reason);
  }
  return `${lines.join('\n')}\n`;
}

function reportToHtml(report: Report): string {
  const markdown = reportToMarkdown(report);
  const body = escapeHtml(markdown)
    .split('\n')
    .map((line) => (line ? `<div>${line}</div>` : '<br/>'))
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>设备诊断报告 ${escapeHtml(report.run_id)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:900px;margin:40px auto;padding:0 20px;line-height:1.65;color:#111}
h1{font-size:22px} .meta{color:#555} div{white-space:pre-wrap}
</style>
</head>
<body>
<h1>设备诊断报告</h1>
<div class="meta">${escapeHtml(report.run_id)} · ${escapeHtml(report.as_of)}</div>
<pre style="white-space:pre-wrap;font-family:inherit">${body}</pre>
</body>
</html>`;
}

const CreateRunSchema = z
  .object({
    workspace_id: z.string().optional(),
    alarm_id: z.string().optional(),
    equipment_id: z.string().min(1),
    window: WindowSchema,
    symptom: z.string().min(1).max(4000),
    data_mode: z.enum(['mock', 'replay', 'live']).optional(),
    model_mode: z.enum(['fixture', 'live']).optional(),
    scenario_id: z.string().optional(),
  })
  .strict();

const ReviewBodySchema = z
  .object({
    workspace_id: z.string().optional(),
    decision: z.enum(['accepted', 'rejected']),
    comment: z.string().max(4000).default(''),
    observations: z.array(z.string().max(1000)).max(20).default([]),
  })
  .strict();

const ApprovalCreateSchema = z
  .object({
    workspace_id: z.string().optional(),
    action_id: z.string().min(1).max(120),
    risk_level: z.enum(['read', 'knowledge_read', 'control_intent', 'control']),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const ApprovalDecisionSchema = z
  .object({
    workspace_id: z.string().optional(),
    decision: z.enum(['approved', 'rejected']),
  })
  .strict();

const SourceUpsertSchema = z
  .object({
    workspace_id: z.string().optional(),
    id: z.string().min(1).max(80),
    kind: z.enum(['scada', 'mes', 'work_order', 'rootcloud', 'manual', 'case']),
    name: z.string().min(1).max(160),
    data_mode: z.enum(['mock', 'replay', 'live']),
    auth_kind: z.string().min(1).max(80),
    notes: z.string().max(1000).default(''),
  })
  .strict();

const DocumentImportSchema = z
  .object({
    workspace_id: z.string().optional(),
    document_id: z.string().min(1).max(120),
    file_path: z.string().min(1).max(1000),
    title: z.string().min(1).max(300),
    vendor: z.string().min(1).max(160),
    model: z.string().min(1).max(80),
    manual_version: z.string().min(1).max(40),
    effective_date: z.string().nullable().optional(),
  })
  .strict();

const AlarmWebhookSchema = z
  .object({
    workspace_id: z.string().min(1),
    source_id: z.string().min(1),
    source_alarm_id: z.string().min(1),
    equipment_id: z.string().min(1),
    code: z.string().min(1).max(120),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    state: z.enum(['active', 'cleared', 'unknown']),
    raised_at: z.string().min(1),
    cleared_at: z.string().nullable().optional(),
    message: z.string().max(2000).default(''),
  })
  .strict();

const EvalCreateSchema = z
  .object({
    split: z.enum(['dev', 'holdout', 'all']).default('all'),
    limit: z.number().int().positive().max(100).nullable().optional(),
    mode: z.enum(['fixture', 'live']).optional(),
  })
  .strict();

function webhookSecret(workspaceId: string, sourceId: string): string | null {
  const raw = process.env.DIAGNOSIS_WEBHOOK_SECRETS;
  if (!raw) return null;
  try {
    const map = JSON.parse(raw) as Record<string, unknown>;
    const scoped = map[`${workspaceId}:${sourceId}`];
    if (typeof scoped === 'string' && scoped.length > 0) return scoped;
    const plain = map[sourceId];
    return typeof plain === 'string' && plain.length > 0 ? plain : null;
  } catch {
    return null;
  }
}

function verifyWebhook(
  workspaceId: string,
  sourceId: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
): void {
  const secret = webhookSecret(workspaceId, sourceId);
  if (!secret) {
    fail(
      503,
      'WEBHOOK_UNCONFIGURED',
      '未配置该来源的 Webhook 密钥；拒绝接收未签名报警。',
    );
  }
  if (!timestamp || !signature) {
    fail(
      401,
      'WEBHOOK_UNAUTHORIZED',
      '缺少 x-diagnosis-timestamp / x-diagnosis-signature',
    );
  }
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) {
    fail(401, 'WEBHOOK_REPLAY', 'Webhook 时间戳超出 5 分钟窗口');
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${workspaceId}.${rawBody}`)
    .digest('hex');
  const provided = signature.replace(/^sha256=/, '');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    fail(401, 'WEBHOOK_UNAUTHORIZED', 'Webhook 签名不匹配');
  }
}

export function createDiagnosisRoutes(
  runtime: DiagnosisRuntime,
): Hono<DiagnosisEnv> {
  const routes = new Hono<DiagnosisEnv>();

  routes.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status as 400,
      );
    }
    console.error('[diagnosis] unhandled route error', error);
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: '服务内部错误，已记录日志。',
        },
      },
      500,
    );
  });

  // Webhook 使用独立 HMAC，不使用浏览器 Cookie；必须放在 authMiddleware 之前。
  routes.post('/alarm-events', async (c) => {
    const rawBody = await c.req.text();
    let body: z.infer<typeof AlarmWebhookSchema>;
    try {
      body = parseOrFail(AlarmWebhookSchema, JSON.parse(rawBody));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(400, 'INVALID_JSON', '请求体不是合法 JSON');
    }
    verifyWebhook(
      body.workspace_id,
      body.source_id,
      c.req.header('x-diagnosis-timestamp'),
      c.req.header('x-diagnosis-signature'),
      rawBody,
    );
    const source = runtime.repo
      .listSources(body.workspace_id)
      .find((item) => item.id === body.source_id);
    if (!source) fail(404, 'SOURCE_NOT_FOUND', '来源不存在');
    const equipment = runtime.repo.getEquipment(
      body.workspace_id,
      body.equipment_id,
    );
    if (!equipment) fail(404, 'EQUIPMENT_NOT_FOUND', '设备不存在');
    const idempotencyKey = `webhook|${body.source_id}|${body.source_alarm_id}|${body.raised_at}`;
    const stored = runtime.repo.upsertAlarm({
      id: stableScopedId('alm', body.workspace_id, idempotencyKey),
      workspaceId: body.workspace_id,
      sourceId: body.source_id,
      sourceAlarmId: body.source_alarm_id,
      equipmentId: body.equipment_id,
      code: body.code,
      severity: body.severity,
      state: body.state,
      raisedAt: body.raised_at,
      clearedAt: body.cleared_at ?? null,
      message: body.message,
      dataMode: source.data_mode,
      idempotencyKey,
      scenarioId: null,
    });
    return c.json(
      { alarm: stored.alarm, created: stored.created },
      stored.created ? 201 : 200,
    );
  });

  routes.use('*', async (c, next) => {
    if (c.req.path.endsWith('/alarm-events')) return next();
    return authMiddleware(c, next);
  });

  routes.get('/meta', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    return c.json({
      workspace_id: workspaceId,
      model_mode: runtime.modelMode,
      data_mode: runtime.dataMode,
      fts_tokenizer: runtime.ftsTokenizer,
      live_eval: 'NOT_RUN',
      control_execution: CONTROL_EXECUTION,
      demo_scenarios: DEMO_SCENARIOS,
    });
  });

  // -------------------------------------------------------------------------
  // Demo seed
  // -------------------------------------------------------------------------

  routes.post('/demo/seed', async (c) => {
    const user = userOf(c);
    const body = await readBody(c);
    const workspaceId = resolveWorkspace(
      user,
      typeof body.workspace_id === 'string' ? body.workspace_id : null,
    );
    const result = await seedDemoWorkspace(runtime, workspaceId);
    return c.json({
      workspace_id: workspaceId,
      seed: result.seed,
      demo_alarms: result.demo_alarms,
      data_mode: 'mock',
    });
  });

  // -------------------------------------------------------------------------
  // Alarms / equipment
  // -------------------------------------------------------------------------

  routes.get('/alarms', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const alarms = runtime.repo.listAlarms(workspaceId, {
      state: c.req.query('state') || undefined,
      severity: c.req.query('severity') || undefined,
      equipmentId: c.req.query('equipment_id') || undefined,
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
      limit: Number(c.req.query('limit') ?? 100),
    });
    return c.json({ workspace_id: workspaceId, alarms });
  });

  routes.get('/alarms/:id', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const alarm = runtime.repo.getAlarm(workspaceId, c.req.param('id'));
    if (!alarm) fail(404, 'ALARM_NOT_FOUND', '报警不存在');
    const equipment = runtime.repo.getEquipment(
      workspaceId,
      alarm.equipment_id,
    );
    const runs = runtime.repo
      .listRuns(workspaceId, 200)
      .filter((run) => run.alarm_id === alarm.id)
      .map((run) => runView(runtime, run));
    return c.json({ alarm, equipment, runs });
  });

  routes.get('/equipment', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    return c.json({
      workspace_id: workspaceId,
      equipment: runtime.repo.listEquipment(workspaceId),
    });
  });

  routes.get('/equipment/:id', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const equipment = runtime.repo.getEquipment(workspaceId, c.req.param('id'));
    if (!equipment) fail(404, 'EQUIPMENT_NOT_FOUND', '设备不存在');
    return c.json({
      equipment,
      alarms: runtime.repo.listAlarms(workspaceId, {
        equipmentId: equipment.equipment_id,
        limit: 100,
      }),
      runs: runtime.repo
        .listRuns(workspaceId, 200)
        .filter((run) => run.equipment_id === equipment.equipment_id)
        .slice(0, 50)
        .map((run) => runView(runtime, run)),
      sources: runtime.repo.listSources(workspaceId),
    });
  });

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  routes.post('/runs', async (c) => {
    const user = userOf(c);
    const body = parseOrFail(CreateRunSchema, await readBody(c));
    const workspaceId = resolveWorkspace(user, body.workspace_id);
    const equipment = runtime.repo.getEquipment(workspaceId, body.equipment_id);
    if (!equipment) fail(404, 'EQUIPMENT_NOT_FOUND', '设备不存在');

    let alarmId: string | null = null;
    let scenarioId: string | null = null;
    if (body.alarm_id) {
      const alarm = runtime.repo.getAlarm(workspaceId, body.alarm_id);
      if (!alarm) fail(404, 'ALARM_NOT_FOUND', '报警不存在');
      if (alarm.equipment_id !== body.equipment_id) {
        fail(400, 'ALARM_EQUIPMENT_MISMATCH', '报警与设备不匹配');
      }
      const existing = runtime.repo.findRunByAlarm(workspaceId, alarm.id);
      if (existing) {
        return c.json({ run: runView(runtime, existing), created: false }, 200);
      }
      alarmId = alarm.id;
      scenarioId = alarm.scenario_id;
    }
    if (body.scenario_id && body.scenario_id !== scenarioId) {
      if (process.env.DIAGNOSIS_ALLOW_SCENARIOS !== '1') {
        fail(400, 'SCENARIO_NOT_ALLOWED', '普通诊断请求不能指定场景覆盖');
      }
      scenarioId = body.scenario_id;
    }

    const dataMode: DataMode = body.data_mode ?? 'mock';
    if (dataMode === 'live') {
      const liveSources = liveSourcesReady(runtime.repo, workspaceId);
      if (liveSources.length === 0) {
        fail(
          409,
          'LIVE_SOURCES_UNCONFIGURED',
          '没有已配置的实时来源；本版仅提供 Mock/回放数据。',
        );
      }
    }
    const modelMode: ModelMode = body.model_mode ?? runtime.modelMode;
    if (modelMode !== runtime.modelMode) {
      fail(
        409,
        'MODEL_MODE_FIXED',
        `当前服务以 ${runtime.modelMode} 模式启动，不能按 Run 切换模型模式。`,
      );
    }
    const run = runtime.repo.createRun({
      id: newId('run'),
      workspaceId,
      userId: user.id,
      alarmId,
      equipmentId: body.equipment_id,
      window: body.window,
      symptom: body.symptom,
      dataMode,
      modelMode,
      budget: DEFAULT_BUDGET,
      scenarioId,
    });
    eventOf(runtime, run.id, 'run.created', {
      workspace_id: workspaceId,
      equipment_id: run.equipment_id,
      alarm_id: alarmId,
      data_mode: dataMode,
      model_mode: modelMode,
      scenario_id: scenarioId,
    });
    runtime.worker.kick();
    return c.json({ run: runView(runtime, run), created: true }, 201);
  });

  routes.get('/runs', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const status = c.req.query('status');
    const equipmentId = c.req.query('equipment_id');
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
    const runs = runtime.repo
      .listRuns(workspaceId, limit)
      .filter((run) => !status || run.status === status)
      .filter((run) => !equipmentId || run.equipment_id === equipmentId)
      .map((run) => runView(runtime, run));
    return c.json({ workspace_id: workspaceId, runs });
  });

  routes.get('/runs/:id', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const run = runtime.repo.getRun(c.req.param('id'));
    if (!run || run.workspace_id !== workspaceId) {
      fail(404, 'RUN_NOT_FOUND', '诊断任务不存在');
    }
    return c.json(runDetail(runtime, run));
  });

  routes.post('/runs/:id/cancel', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const run = runtime.repo.getRun(c.req.param('id'));
    if (!run || run.workspace_id !== workspaceId) {
      fail(404, 'RUN_NOT_FOUND', '诊断任务不存在');
    }
    if (run.status !== 'queued' && run.status !== 'running') {
      return c.json({ run: runView(runtime, run), cancelled: false }, 200);
    }
    const active = runtime.worker.cancel(run.id);
    runtime.repo.updateRun(run.id, {
      status: 'cancelled',
      finished_at: nowIso(),
      lease_owner: null,
      lease_expires_at: null,
    });
    eventOf(runtime, run.id, 'run.cancelled', {
      by: user.id,
      active_execution: active,
    });
    return c.json(
      {
        run: runView(runtime, runtime.repo.getRun(run.id) ?? run),
        cancelled: true,
      },
      202,
    );
  });

  routes.post('/runs/:id/resume', async (c) => {
    const user = userOf(c);
    const body = await readBody(c);
    const workspaceId = resolveWorkspace(
      user,
      typeof body.workspace_id === 'string' ? body.workspace_id : null,
    );
    const run = runtime.repo.getRun(c.req.param('id'));
    if (!run || run.workspace_id !== workspaceId) {
      fail(404, 'RUN_NOT_FOUND', '诊断任务不存在');
    }
    if (run.status !== 'awaiting_human') {
      fail(
        409,
        'RUN_NOT_RESUMABLE',
        '只有等待人工复核的任务可以补充信息后继续',
      );
    }
    const note =
      typeof body.note === 'string' && body.note.trim()
        ? body.note.trim().slice(0, 2000)
        : '补充信息后继续诊断';
    const resumed = runtime.repo.createRun({
      id: newId('run'),
      workspaceId,
      userId: user.id,
      alarmId: run.alarm_id,
      equipmentId: run.equipment_id,
      window: run.window,
      symptom: `${run.symptom ?? ''}\n补充信息：${note}`.trim(),
      dataMode: run.data_mode,
      modelMode: run.model_mode,
      budget: run.budget,
      scenarioId: runtime.repo.getRunScenario(run.id),
    });
    runtime.repo.updateRun(resumed.id, {
      checkpoint: { resumed_from_run_id: run.id, resume_note: note },
    });
    eventOf(runtime, resumed.id, 'run.created', {
      workspace_id: workspaceId,
      resumed_from_run_id: run.id,
      note,
    });
    runtime.worker.kick();
    return c.json(
      {
        run: runView(runtime, runtime.repo.getRun(resumed.id) ?? resumed),
        created: true,
        resumed_from: run.id,
      },
      201,
    );
  });

  routes.get('/runs/:id/events', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const run = runtime.repo.getRun(c.req.param('id'));
    if (!run || run.workspace_id !== workspaceId) {
      fail(404, 'RUN_NOT_FOUND', '诊断任务不存在');
    }
    const afterSeq = Number(c.req.query('after_seq') ?? 0);
    const limit = Math.min(Number(c.req.query('limit') ?? 500), 500);
    return c.json({
      events: runtime.repo.listEvents(run.id, afterSeq, limit),
    });
  });

  routes.get('/runs/:id/evidence/:eid', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const run = runtime.repo.getRun(c.req.param('id'));
    if (!run || run.workspace_id !== workspaceId) {
      fail(404, 'RUN_NOT_FOUND', '诊断任务不存在');
    }
    const evidence = runtime.repo.getEvidence(run.id, c.req.param('eid'));
    if (!evidence) fail(404, 'EVIDENCE_NOT_FOUND', '证据不存在');
    const payload = evidence.payload;
    const document =
      payload.kind === 'manual_chunk'
        ? runtime.repo.getDocument(workspaceId, payload.document_id)
        : null;
    return c.json({ evidence, document });
  });

  routes.get('/runs/:id/report', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const run = runtime.repo.getRun(c.req.param('id'));
    if (!run || run.workspace_id !== workspaceId) {
      fail(404, 'RUN_NOT_FOUND', '诊断任务不存在');
    }
    const record = runtime.repo.getReport(run.id);
    if (!record) fail(404, 'REPORT_NOT_READY', '报告尚未生成');
    const report = currentReport(runtime, run)!;
    const format = (c.req.query('format') ?? 'json').toLowerCase();
    if (format === 'markdown' || format === 'md') {
      return c.body(reportToMarkdown(report), 200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="diagnosis-${run.id}.md"`,
      });
    }
    if (format === 'html') {
      return c.html(reportToHtml(report));
    }
    return c.json({ report, validation: record.validation });
  });

  routes.get('/runs/:id/reviews', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const run = runtime.repo.getRun(c.req.param('id'));
    if (!run || run.workspace_id !== workspaceId) {
      fail(404, 'RUN_NOT_FOUND', '诊断任务不存在');
    }
    return c.json({ reviews: runtime.repo.listReviews(run.id) });
  });

  routes.post('/runs/:id/reviews', async (c) => {
    const user = userOf(c);
    const body = parseOrFail(ReviewBodySchema, await readBody(c));
    const workspaceId = resolveWorkspace(
      user,
      body.workspace_id ?? c.req.query('workspace_id'),
    );
    const run = runtime.repo.getRun(c.req.param('id'));
    if (!run || run.workspace_id !== workspaceId) {
      fail(404, 'RUN_NOT_FOUND', '诊断任务不存在');
    }
    if (run.status !== 'awaiting_human' && run.status !== 'completed') {
      fail(409, 'RUN_NOT_REVIEWABLE', '当前任务状态不能提交复核');
    }
    const review = runtime.repo.submitReview({
      id: newId('review'),
      runId: run.id,
      reviewerId: user.id,
      decision: body.decision,
      comment: body.comment,
      observations: body.observations,
    });
    return c.json({ review }, 201);
  });

  // -------------------------------------------------------------------------
  // Approvals (recommendation intent only; control execution disabled)
  // -------------------------------------------------------------------------

  routes.get('/approvals', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    return c.json({
      approvals: runtime.repo.listApprovals(
        workspaceId,
        c.req.query('status') || undefined,
      ),
      control_execution: CONTROL_EXECUTION,
    });
  });

  routes.post('/runs/:id/approvals', async (c) => {
    const user = userOf(c);
    const body = parseOrFail(ApprovalCreateSchema, await readBody(c));
    const workspaceId = resolveWorkspace(
      user,
      body.workspace_id ?? c.req.query('workspace_id'),
    );
    const run = runtime.repo.getRun(c.req.param('id'));
    if (!run || run.workspace_id !== workspaceId) {
      fail(404, 'RUN_NOT_FOUND', '诊断任务不存在');
    }
    if (run.status !== 'awaiting_human') {
      fail(
        409,
        'RUN_NOT_AWAITING_HUMAN',
        '只有等待人工复核的任务可以申请建议审批',
      );
    }
    runtime.repo.invalidateApprovals(run.id);
    const evidence = runtime.repo.listEvidence(run.id);
    const approval = {
      id: newId('approval'),
      run_id: run.id,
      workspace_id: workspaceId,
      action_id: body.action_id,
      equipment_id: run.equipment_id,
      risk_level: body.risk_level,
      params_hash: sha256(
        canonicalJson({
          run_id: run.id,
          action_id: body.action_id,
          params: body.params,
        }),
      ),
      evidence_snapshot_hash: sha256(
        canonicalJson(
          evidence.map((item) => ({
            id: item.id,
            payload_hash: item.payload_hash,
          })),
        ),
      ),
      requested_by: user.id,
      approved_by: null,
      status: 'pending' as const,
      receipt_status: null,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      policy_version: 'diagnosis-policy-v1',
      created_at: nowIso(),
    };
    runtime.repo.createApproval(approval);
    return c.json(
      {
        approval,
        control_execution: CONTROL_EXECUTION,
        message: '审批只确认建议意图，本版不会执行任何设备控制。',
      },
      201,
    );
  });

  routes.post('/approvals/:id/decision', async (c) => {
    const user = userOf(c);
    const body = parseOrFail(ApprovalDecisionSchema, await readBody(c));
    const workspaceId = resolveWorkspace(
      user,
      body.workspace_id ?? c.req.query('workspace_id'),
    );
    const approval = runtime.repo.getApproval(workspaceId, c.req.param('id'));
    if (!approval) fail(404, 'APPROVAL_NOT_FOUND', '审批不存在');
    if (approval.status !== 'pending') {
      fail(409, 'APPROVAL_NOT_PENDING', '审批已处理或已失效');
    }
    if (approvalExpired(approval)) {
      fail(409, 'APPROVAL_EXPIRED', '审批已过期，请重新申请');
    }
    if (selfApprovalForbidden(approval, user.id)) {
      fail(403, 'SELF_APPROVAL_FORBIDDEN', '高风险建议不能由申请人自己审批');
    }
    const updated = runtime.repo.decideApproval(
      workspaceId,
      approval.id,
      user.id,
      body.decision,
    );
    return c.json({
      approval: updated,
      control_execution: CONTROL_EXECUTION,
      message:
        body.decision === 'approved'
          ? '建议意图已批准；本版不执行设备控制，请工程师按规程现场处理。'
          : '建议意图已驳回。',
    });
  });

  // -------------------------------------------------------------------------
  // Sources / knowledge
  // -------------------------------------------------------------------------

  routes.get('/sources', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    return c.json({
      sources: runtime.repo.listSources(workspaceId),
      workspace_id: workspaceId,
    });
  });

  routes.post('/sources', async (c) => {
    const user = userOf(c);
    requireAdmin(user);
    const body = parseOrFail(SourceUpsertSchema, await readBody(c));
    const workspaceId = resolveWorkspace(
      user,
      body.workspace_id ?? c.req.query('workspace_id'),
    );
    const status =
      body.data_mode === 'mock'
        ? 'mock'
        : body.data_mode === 'replay'
          ? 'configured'
          : 'unconfigured';
    runtime.repo.upsertSource(workspaceId, {
      id: body.id,
      workspace_id: workspaceId,
      kind: body.kind,
      name: body.name,
      data_mode: body.data_mode,
      status,
      auth_kind: body.auth_kind,
      last_test_at: null,
      last_test_ok: null,
      notes: body.notes,
    });
    return c.json(
      {
        source: runtime.repo
          .listSources(workspaceId)
          .find((item) => item.id === body.id),
      },
      201,
    );
  });

  routes.post('/sources/:id/test', async (c) => {
    const user = userOf(c);
    requireAdmin(user);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const source = runtime.repo
      .listSources(workspaceId)
      .find((item) => item.id === c.req.param('id'));
    if (!source) fail(404, 'SOURCE_NOT_FOUND', '来源不存在');
    if (source.data_mode === 'live') {
      // 设备台账的 source_ids 按来源类型（scada/mes/...）记录外部设备号；
      // 用来源类型找到一台已登记设备作为只读健康检查的查询目标。
      const equipment = runtime.repo
        .listEquipment(workspaceId)
        .find((item) => Boolean(item.source_ids?.[source.kind]));
      const health = await testLiveSource({
        source,
        equipmentId: equipment?.equipment_id ?? null,
      });
      runtime.repo.updateSourceTest(
        workspaceId,
        source.id,
        health.ok,
        health.message,
      );
      runtime.repo.updateSourceStatus(
        workspaceId,
        source.id,
        health.ok ? 'configured' : 'unconfigured',
      );
      return c.json(
        {
          ok: health.ok,
          mode: source.data_mode,
          code: health.code,
          message: health.message,
        },
        health.ok ? 200 : 409,
      );
    }
    if (source.status === 'unconfigured') {
      runtime.repo.updateSourceTest(
        workspaceId,
        source.id,
        false,
        '真实适配器未配置；本版不猜测企业接口签名。',
      );
      return c.json(
        {
          ok: false,
          mode: source.data_mode,
          code: 'ADAPTER_NOT_CONFIGURED',
          message: '真实适配器未配置；本版不猜测企业接口签名。',
        },
        409,
      );
    }
    if (source.data_mode === 'mock') {
      runtime.repo.updateSourceTest(
        workspaceId,
        source.id,
        true,
        '模拟来源可用；未连接真实企业系统。',
      );
      return c.json({
        ok: true,
        mode: 'mock',
        message: '模拟来源可用；未连接真实企业系统。',
      });
    }
    if (source.data_mode === 'replay') {
      runtime.repo.updateSourceTest(
        workspaceId,
        source.id,
        true,
        '回放来源可用；数据来自固定快照。',
      );
      return c.json({
        ok: true,
        mode: 'replay',
        message: '回放来源可用；数据来自固定快照。',
      });
    }
    fail(409, 'ADAPTER_NOT_CONFIGURED', '未知来源模式，拒绝测试。');
  });

  routes.get('/documents', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    return c.json({
      documents: runtime.repo.listDocuments(workspaceId),
      fts_tokenizer: runtime.ftsTokenizer,
    });
  });

  routes.post('/documents/import', async (c) => {
    const user = userOf(c);
    requireAdmin(user);
    const body = parseOrFail(DocumentImportSchema, await readBody(c));
    const workspaceId = resolveWorkspace(
      user,
      body.workspace_id ?? c.req.query('workspace_id'),
    );
    try {
      const result = await runtime.knowledge.importFile({
        workspaceId,
        documentId: body.document_id,
        filePath: body.file_path,
        title: body.title,
        vendor: body.vendor,
        model: body.model,
        manualVersion: body.manual_version,
        effectiveDate: body.effective_date ?? null,
      });
      return c.json({ result }, 201);
    } catch (error) {
      fail(
        400,
        'DOCUMENT_IMPORT_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  routes.post('/documents/:id/withdraw', (c) => {
    const user = userOf(c);
    requireAdmin(user);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const document = runtime.repo.getDocument(workspaceId, c.req.param('id'));
    if (!document) fail(404, 'DOCUMENT_NOT_FOUND', '文档不存在');
    runtime.repo.setDocumentWithdrawn(workspaceId, document.document_id, true);
    return c.json({ ok: true, document_id: document.document_id });
  });

  routes.get('/documents/:id/file', (c) => {
    const user = userOf(c);
    const workspaceId = resolveWorkspace(user, c.req.query('workspace_id'));
    const document = runtime.repo.getDocument(workspaceId, c.req.param('id'));
    if (!document) fail(404, 'DOCUMENT_NOT_FOUND', '文档不存在');
    let abs: string;
    try {
      abs = runtime.knowledge.resolveAllowedPath(
        path.resolve(document.file_path),
      );
    } catch (error) {
      fail(
        403,
        'DOCUMENT_PATH_FORBIDDEN',
        error instanceof Error ? error.message : '文档路径不可访问',
      );
    }
    const stat = fs.statSync(abs);
    if (stat.size > 20 * 1024 * 1024) {
      fail(413, 'DOCUMENT_TOO_LARGE', '文档超过 20MB，拒绝在线预览');
    }
    const ext = path.extname(abs).toLowerCase();
    const contentType =
      ext === '.pdf'
        ? 'application/pdf'
        : ext === '.md'
          ? 'text/markdown; charset=utf-8'
          : 'text/plain; charset=utf-8';
    const filename = path.basename(abs).replaceAll(/["\r\n]/g, '_');
    return c.body(fs.readFileSync(abs), 200, {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, max-age=60',
    });
  });

  // -------------------------------------------------------------------------
  // Eval
  // -------------------------------------------------------------------------

  routes.get('/eval-runs', (c) => {
    const user = userOf(c);
    requireAdmin(user);
    return c.json({ eval_runs: runtime.repo.listEvalRuns(20) });
  });

  routes.get('/eval-runs/:id', (c) => {
    const user = userOf(c);
    requireAdmin(user);
    const record = runtime.repo.getEvalRun(c.req.param('id'));
    if (!record) fail(404, 'EVAL_NOT_FOUND', 'Eval 运行不存在');
    return c.json({ eval_run: record });
  });

  routes.get('/eval-runs/:id/traces/:caseId', (c) => {
    const user = userOf(c);
    requireAdmin(user);
    const record = runtime.repo.getEvalRun(c.req.param('id'));
    if (!record) fail(404, 'EVAL_NOT_FOUND', 'Eval 运行不存在');
    try {
      const file = evalTracePath(
        c.req.param('id'),
        c.req.param('caseId'),
        path.resolve('work/diagnosis'),
      );
      if (!fs.existsSync(file)) fail(404, 'TRACE_NOT_FOUND', 'trace 不存在');
      return c.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(400, 'TRACE_READ_FAILED', 'trace 读取失败');
    }
  });

  routes.post('/eval-runs', async (c) => {
    const user = userOf(c);
    requireAdmin(user);
    const body = parseOrFail(EvalCreateSchema, await readBody(c));
    const mode: ModelMode = body.mode ?? runtime.modelMode;
    if (mode !== runtime.modelMode) {
      fail(
        409,
        'MODEL_MODE_FIXED',
        `当前服务以 ${runtime.modelMode} 模式启动，不能按 Eval 切换模型模式。`,
      );
    }
    const evalRunId = newId('eval');
    runtime.repo.createEvalRun({
      id: evalRunId,
      mode,
      split: body.split,
    });
    void runEvalSuite({
      split: body.split,
      limit: body.limit ?? null,
      mode,
      evalRunId,
      fixturesDir: runtime.fixturesDir,
      onCase: (result) => {
        console.log(
          `[eval ${evalRunId}] ${result.case_id} ${
            result.passed ? 'PASS' : 'FAIL'
          }`,
        );
      },
    })
      .then((summary) => {
        runtime.repo.finishEvalRun({
          id: evalRunId,
          status: summary.status,
          metrics: summary.metrics,
          results: summary.case_results,
          error: summary.threshold_check.ok
            ? null
            : summary.threshold_check.failures.join('; '),
        });
      })
      .catch((error) => {
        runtime.repo.finishEvalRun({
          id: evalRunId,
          status: 'failed',
          metrics: aggregateMetrics([]),
          results: [],
          error:
            error instanceof EvalNotRunError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
        });
      });
    return c.json(
      {
        eval_run_id: evalRunId,
        status: 'running',
        mode,
        split: body.split,
        traces: `work/diagnosis/eval/${evalRunId}/traces`,
      },
      202,
    );
  });

  return routes;
}
