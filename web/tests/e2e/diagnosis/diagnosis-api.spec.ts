import crypto from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ensureDemoData, ensureSession } from './helpers.js';

const WEBHOOK_SECRET = 'e2e-webhook-secret';

function signedHeaders(workspaceId: string, rawBody: string) {
  const timestamp = new Date().toISOString();
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${workspaceId}.${rawBody}`)
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-diagnosis-timestamp': timestamp,
    'x-diagnosis-signature': `sha256=${signature}`,
  };
}

async function workspaceOf(page: import('@playwright/test').Page) {
  const response = await page.request.get('/api/diagnosis/alarms');
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    workspace_id: string;
    alarms: Array<{ id: string; source_alarm_id: string }>;
  };
}

test('webhook duplicate alarm is idempotent and cross-workspace access is rejected', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureSession(page);
  await ensureDemoData(page);

  const before = await workspaceOf(page);
  const workspaceId = before.workspace_id;

  // 其他工作区不能通过查询参数读取本工作区数据。
  const crossWorkspace = await page.request.get(
    '/api/diagnosis/alarms?workspace_id=ws_e2e_other',
  );
  expect(crossWorkspace.status()).toBe(404);
  expect(
    ((await crossWorkspace.json()) as { error: { code: string } }).error.code,
  ).toBe('WORKSPACE_NOT_FOUND');

  const raisedAt = new Date().toISOString();
  const sourceAlarmId = `E2E-DUP-${Date.now()}`;
  const rawBody = JSON.stringify({
    workspace_id: workspaceId,
    source_id: 'src-scada',
    source_alarm_id: sourceAlarmId,
    equipment_id: 'EQ-DEMO-001',
    code: 'DEMO-BRG-01',
    severity: 'high',
    state: 'active',
    raised_at: raisedAt,
    cleared_at: null,
    message: 'E2E 重复报警幂等检查',
  });

  const first = await page.request.post('/api/diagnosis/alarm-events', {
    headers: signedHeaders(workspaceId, rawBody),
    data: rawBody,
  });
  expect(first.status()).toBe(201);
  const firstBody = (await first.json()) as {
    alarm: { id: string };
    created: boolean;
  };
  expect(firstBody.created).toBe(true);

  const second = await page.request.post('/api/diagnosis/alarm-events', {
    headers: signedHeaders(workspaceId, rawBody),
    data: rawBody,
  });
  expect(second.status()).toBe(200);
  const secondBody = (await second.json()) as {
    alarm: { id: string };
    created: boolean;
  };
  expect(secondBody.created).toBe(false);
  expect(secondBody.alarm.id).toBe(firstBody.alarm.id);

  const after = await workspaceOf(page);
  expect(after.alarms.length).toBe(before.alarms.length + 1);
  expect(
    after.alarms.filter((alarm) => alarm.source_alarm_id === sourceAlarmId),
  ).toHaveLength(1);

  const crossAlarm = await page.request.get(
    `/api/diagnosis/alarms/${firstBody.alarm.id}?workspace_id=ws_e2e_other`,
  );
  expect(crossAlarm.status()).toBe(404);
});

test('wrong manual version is explicit and does not contaminate a valid run', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureSession(page);
  await ensureDemoData(page);

  const workspace = await workspaceOf(page);
  const workspaceId = workspace.workspace_id;

  const imported = await page.request.post('/api/diagnosis/documents/import', {
    data: {
      workspace_id: workspaceId,
      document_id: 'DOC-E2E-OBSOLETE',
      file_path: path.resolve(
        process.cwd(),
        '../fixtures/diagnosis/manuals/np200-v2-zh.md',
      ),
      title: 'E2E 过期版本手册',
      vendor: 'Northwind Pumps',
      model: 'NP-200',
      manual_version: 'OBSOLETE-v0',
      effective_date: '2020-01-01',
    },
  });
  expect(imported.status()).toBe(201);

  const documents = (await (
    await page.request.get('/api/diagnosis/documents')
  ).json()) as {
    documents: Array<{
      document_id: string;
      manual_version: string;
      withdrawn: boolean;
    }>;
  };
  const obsolete = documents.documents.find(
    (document) => document.document_id === 'DOC-E2E-OBSOLETE',
  );
  expect(obsolete?.manual_version).toBe('OBSOLETE-v0');

  const withdrawn = await page.request.post(
    '/api/diagnosis/documents/DOC-E2E-OBSOLETE/withdraw',
  );
  expect(withdrawn.ok()).toBeTruthy();
  const afterWithdraw = (await (
    await page.request.get('/api/diagnosis/documents')
  ).json()) as {
    documents: Array<{ document_id: string; withdrawn: boolean }>;
  };
  expect(
    afterWithdraw.documents.find(
      (document) => document.document_id === 'DOC-E2E-OBSOLETE',
    )?.withdrawn,
  ).toBe(true);

  // 过期文档存在时，引用设备登记版本（v2）的运行仍必须通过校验。
  const created = await page.request.post('/api/diagnosis/runs', {
    data: {
      workspace_id: workspaceId,
      equipment_id: 'EQ-DEMO-001',
      window: {
        start: '2026-11-07T00:00:00.000Z',
        end: '2026-11-07T00:30:00.000Z',
      },
      symptom: '1号循环泵轴承温度持续上升，振动与电流稳定',
      data_mode: 'mock',
      model_mode: 'fixture',
      scenario_id: 'demo-sensor-drift',
    },
  });
  expect(created.status()).toBe(201);
  const run = ((await created.json()) as { run: { id: string } }).run;

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/diagnosis/runs/${run.id}`,
        );
        const body = (await response.json()) as {
          run: { status: string };
        };
        return body.run.status;
      },
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toBe('awaiting_human');

  const report = (await (
    await page.request.get(`/api/diagnosis/runs/${run.id}/report`)
  ).json()) as {
    validation: { valid: boolean; issues: Array<{ code: string }> };
  };
  expect(report.validation.valid).toBe(true);
  expect(
    report.validation.issues.some(
      (issue) => issue.code === 'MANUAL_VERSION_MISMATCH',
    ),
  ).toBe(false);
});

test('live source test flips status and a live run reaches the worker', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureSession(page);
  await ensureDemoData(page);

  const workspace = await workspaceOf(page);
  const workspaceId = workspace.workspace_id;

  const createdSource = await page.request.post('/api/diagnosis/sources', {
    data: {
      workspace_id: workspaceId,
      id: 'src-e2e-live',
      kind: 'scada',
      name: 'E2E 本地假 REST',
      data_mode: 'live',
      auth_kind: 'bearer',
      notes: '仅连接本机假服务，不访问外网。',
    },
  });
  expect(createdSource.status()).toBe(201);
  const unconfigured = (await createdSource.json()) as {
    source: { status: string };
  };
  expect(unconfigured.source.status).toBe('unconfigured');

  const tested = await page.request.post(
    '/api/diagnosis/sources/src-e2e-live/test',
  );
  expect(tested.status()).toBe(200);
  const health = (await tested.json()) as {
    ok: boolean;
    code: string;
  };
  expect(health.ok).toBe(true);
  expect(health.code).toBe('OK');

  const sources = (await (
    await page.request.get('/api/diagnosis/sources')
  ).json()) as {
    sources: Array<{
      id: string;
      status: string;
      last_test_ok: boolean | null;
    }>;
  };
  const live = sources.sources.find((source) => source.id === 'src-e2e-live');
  expect(live?.status).toBe('configured');
  expect(live?.last_test_ok).toBe(true);

  const createdRun = await page.request.post('/api/diagnosis/runs', {
    data: {
      workspace_id: workspaceId,
      equipment_id: 'EQ-DEMO-001',
      window: {
        start: '2026-11-07T00:00:00.000Z',
        end: '2026-11-07T00:30:00.000Z',
      },
      symptom: '1号循环泵轴承温度持续上升，振动与电流稳定',
      data_mode: 'live',
      model_mode: 'fixture',
      scenario_id: 'demo-sensor-drift',
    },
  });
  expect(createdRun.status()).toBe(201);
  const run = ((await createdRun.json()) as { run: { id: string } }).run;

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/diagnosis/runs/${run.id}`,
        );
        return ((await response.json()) as { run: { status: string } }).run
          .status;
      },
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toBe('awaiting_human');

  const report = (await (
    await page.request.get(`/api/diagnosis/runs/${run.id}/report`)
  ).json()) as {
    report: { handoff_reason: string | null; limitations: string[] };
  };
  // 通用 REST 适配器只读、不伪造证据；没有证据时必须显式转人工。
  expect(report.report.handoff_reason).toBeTruthy();
});

test('cancelled run survives refresh and cannot be resumed', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureSession(page);
  await ensureDemoData(page);

  const workspace = await workspaceOf(page);
  const workspaceId = workspace.workspace_id;

  let cancelledRunId: string | null = null;
  for (let attempt = 0; attempt < 6 && !cancelledRunId; attempt += 1) {
    const now = Date.now();
    const created = await page.request.post('/api/diagnosis/runs', {
      data: {
        workspace_id: workspaceId,
        equipment_id: 'EQ-DEMO-001',
        window: {
          start: new Date(now - 30 * 60_000).toISOString(),
          end: new Date(now + 30 * 60_000).toISOString(),
        },
        symptom: `E2E 取消与刷新恢复 ${attempt}`,
        data_mode: 'mock',
        model_mode: 'fixture',
        scenario_id: 'demo-source-timeout',
      },
    });
    expect(created.status()).toBe(201);
    const run = ((await created.json()) as { run: { id: string } }).run;
    const cancelled = await page.request.post(
      `/api/diagnosis/runs/${run.id}/cancel`,
    );
    expect([200, 202]).toContain(cancelled.status());
    const body = (await cancelled.json()) as { cancelled: boolean };
    if (body.cancelled) cancelledRunId = run.id;
  }

  expect(cancelledRunId).toBeTruthy();
  const runId = cancelledRunId!;

  const detail = (await (
    await page.request.get(`/api/diagnosis/runs/${runId}`)
  ).json()) as { run: { status: string } };
  expect(detail.run.status).toBe('cancelled');

  const events = (await (
    await page.request.get(`/api/diagnosis/runs/${runId}/events`)
  ).json()) as { events: Array<{ type: string }> };
  expect(events.events.some((event) => event.type === 'run.cancelled')).toBe(
    true,
  );

  const resumed = await page.request.post(
    `/api/diagnosis/runs/${runId}/resume`,
    { data: { workspace_id: workspaceId, note: 'E2E 不应允许续诊已取消任务' } },
  );
  expect(resumed.status()).toBe(409);

  await page.goto(`/diagnosis#/runs/${runId}`);
  await expect(page.getByText('任务已取消').first()).toBeVisible({
    timeout: 30_000,
  });
  await page.reload();
  await expect(page.getByText('任务已取消').first()).toBeVisible({
    timeout: 30_000,
  });
});
