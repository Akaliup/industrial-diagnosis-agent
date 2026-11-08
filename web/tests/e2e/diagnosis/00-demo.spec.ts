import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  ensureDemoData,
  ensureSession,
  openDiagnosis,
  SHOTS,
} from './helpers.js';

interface RunDetail {
  run: {
    id: string;
    status: string;
    stage: string;
    review_status: string;
    data_mode: string;
    model_mode: string;
  };
  report: {
    review_status: string;
    hypotheses: Array<{
      code: string;
      status: string;
      supporting_evidence_ids: string[];
      contradicting_evidence_ids: string[];
    }>;
    limitations: string[];
    recommendations: Array<{ control_execution: string }>;
    handoff_reason: string | null;
  } | null;
  validation: { valid: boolean } | null;
  evidence: Array<{
    id: string;
    source_id: string;
    payload_hash: string;
    locator: Record<string, unknown>;
  }>;
  tool_calls: Array<{ tool: string; status: string; role: string }>;
  model_calls: Array<{ model: string; mode: string }>;
  events: Array<{ type: string }>;
  reviews: Array<{ decision: string }>;
}

function runIdFromUrl(page: Page): string {
  const match = page.url().match(/runs\/(run_[^/?#]+)/);
  if (!match) throw new Error(`当前页面不是诊断工作台：${page.url()}`);
  return match[1];
}

async function runDetail(page: Page, runId: string): Promise<RunDetail> {
  const response = await page.request.get(`/api/diagnosis/runs/${runId}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as RunDetail;
}

/**
 * 在演示库中写入一次真实的 50 例 Fixture 评测。
 *
 * 评测在独立临时库中运行（与 `diagnosis:eval:gate` 相同的数据集和评分），
 * 完成后把结果行复制到演示库。服务进程内的评测会在个别 MCP 子进程请求上
 * 卡住，因此演示使用这条等价路径；数据本身仍是真实跑出的 Fixture 结果。
 */
async function ensureEvalRun(page: Page): Promise<void> {
  const response = await page.request.get('/api/diagnosis/eval-runs');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    eval_runs: Array<{ status: string }>;
  };
  if (body.eval_runs.some((run) => run.status === 'passed')) return;
  const root = path.resolve(process.cwd(), '..');
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/tsx/dist/cli.mjs'),
      path.join(root, 'scripts/diagnosis/seed-demo-eval.ts'),
      path.join(root, 'work/diagnosis/e2e-data/db/messages.db'),
    ],
    { cwd: root, stdio: 'pipe', timeout: 300_000 },
  );
}

test('demo walkthrough captures the real diagnosis journey', async ({
  page,
}) => {
  test.slow();
  test.setTimeout(300_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 阶段 A：真实服务健康检查、空库初始化或登录。
  const health = await page.request.get('/api/health');
  expect(health.ok()).toBeTruthy();
  await ensureSession(page);
  await ensureDemoData(page);

  // 阶段 B：报警收件箱。
  await expect(page.getByText('活动报警')).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'inbox-1440x900.png'),
  });

  // 阶段 C：从 UI 发起诊断，等待五阶段完成。
  await openDiagnosis(page);
  await expect(page.getByText('诊断结论').first()).toBeVisible();
  await expect(page.getByText('候选根因')).toBeVisible();
  await expect(page.getByText('关键观察')).toBeVisible();
  await expect(page.getByText('人工复核')).toBeVisible();
  for (const label of [
    '确认状态',
    '定位异常',
    '生成假设',
    '验证证据',
    '生成报告',
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  const runId = runIdFromUrl(page);
  const detail = await runDetail(page, runId);

  expect(detail.run.status).toBe('awaiting_human');
  expect(detail.run.data_mode).toBe('mock');
  expect(detail.run.model_mode).toBe('fixture');
  expect(detail.validation?.valid).toBe(true);
  expect(detail.tool_calls.length).toBeGreaterThan(0);
  expect(detail.tool_calls.some((call) => call.status === 'success')).toBe(
    true,
  );
  expect(detail.evidence.length).toBeGreaterThan(0);
  for (const evidence of detail.evidence) {
    expect(evidence.payload_hash).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(detail.model_calls.length).toBeGreaterThan(0);
  expect(detail.model_calls.every((call) => call.mode === 'fixture')).toBe(
    true,
  );
  expect(
    detail.events.filter((event) => event.type === 'stage.changed').length,
  ).toBeGreaterThanOrEqual(4);
  expect(
    detail.report?.hypotheses.some(
      (hypothesis) =>
        hypothesis.code === 'sensor_drift' && hypothesis.status === 'supported',
    ),
  ).toBe(true);
  const evidenceIds = new Set(detail.evidence.map((item) => item.id));
  for (const hypothesis of detail.report?.hypotheses ?? []) {
    for (const id of hypothesis.supporting_evidence_ids) {
      expect(evidenceIds.has(id)).toBe(true);
    }
  }
  expect(
    detail.report?.limitations.some((item) => /Mock|模拟/.test(item)),
  ).toBe(true);
  expect(
    detail.report?.limitations.some((item) => /Fixture|预录/.test(item)),
  ).toBe(true);

  await page.screenshot({
    path: path.join(SHOTS, 'workbench-1440x900.png'),
  });

  // 阶段 D：打开证据抽屉，确认来源、hash 与手册/遥测原文可回查。
  const chip = page
    .getByRole('button')
    .filter({ hasText: /^ev_[a-f0-9]+$/ })
    .first();
  await expect(chip).toBeVisible();
  await chip.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Payload hash', { exact: true })).toBeVisible();
  await expect(drawer.getByText(/来源 src-/).first()).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'evidence-drawer-1440x900.png'),
  });
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // 阶段 H：通过 UI 导出 Markdown 报告，并检查引用与免责声明。
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Markdown' }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const markdown = fs.readFileSync(downloadPath!, 'utf8');
  expect(markdown).toContain('# 设备诊断报告');
  expect(markdown).toContain(runId);
  expect(markdown).toContain('## 限制与未解决问题');
  expect(markdown).toMatch(/ev_[a-f0-9]+/);
  expect(markdown).toMatch(/Mock|模拟/);
  expect(markdown).toMatch(/Fixture|预录/);
  expect(markdown).toContain('控制执行：disabled');
  const exportDir = path.resolve(
    process.cwd(),
    '../work/diagnosis/demo-export',
  );
  fs.mkdirSync(exportDir, { recursive: true });
  fs.writeFileSync(path.join(exportDir, `${runId}.md`), markdown);

  // 复核队列（阶段 E 的提交动作由 diagnosis.spec.ts 的复核用例完成）。
  await page.goto('/diagnosis#/reviews');
  await expect(page.getByRole('heading', { name: '复核与审批' })).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'reviews-1440x900.png'),
  });

  // 阶段 G：写入并展示一次真实的 Fixture 50 例评测，打开逐例 Trace。
  await ensureEvalRun(page);
  await page.goto('/diagnosis#/eval');
  await expect(page.getByRole('heading', { name: '评测与回放' })).toBeVisible();
  await expect(page.getByText('50/50', { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('逐例结果')).toBeVisible();
  await expect(page.getByText('越权调用')).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'eval-1440x900.png'),
  });

  // 左侧评测记录选择按钮也使用 diag-code；逐例结果行带 w-24 宽度类。
  const caseRow = page
    .locator('button')
    .filter({ has: page.locator('span.diag-code.w-24') })
    .first();
  await expect(caseRow).toBeVisible();
  await caseRow.click();
  const traceSheet = page.getByRole('dialog');
  await expect(traceSheet).toBeVisible();
  await expect(traceSheet.getByText(/轨迹 /)).toBeVisible();
  const traceText = await traceSheet.locator('pre').first().textContent();
  expect(traceText).toContain('tool_calls');
  await page.keyboard.press('Escape');

  // 响应式截图。HashRouter 不重置滚动位置，截图前必须回到页首。
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/diagnosis#/inbox');
  await expect(page.getByRole('heading', { name: '报警收件箱' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(SHOTS, 'inbox-1024x768.png'),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/diagnosis#/inbox');
  await expect(page.getByRole('heading', { name: '报警收件箱' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // 等抽屉入场动画结束，避免截到半透明状态。
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(SHOTS, 'mobile-nav-390x844.png'),
  });
  await page.keyboard.press('Escape');

  const bodyWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(bodyWidth).toBeLessThanOrEqual(390 + 1);
});

test('source timeout hands off without fabricating a conclusion', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureSession(page);
  await ensureDemoData(page);

  const alarmsResponse = await page.request.get('/api/diagnosis/alarms');
  expect(alarmsResponse.ok()).toBeTruthy();
  const alarmsBody = (await alarmsResponse.json()) as {
    alarms: Array<{
      id: string;
      equipment_id: string;
      raised_at: string;
      message: string;
      scenario_id: string;
    }>;
  };
  const alarm = alarmsBody.alarms.find(
    (item) => item.scenario_id === 'demo-source-timeout',
  );
  expect(alarm).toBeTruthy();
  const raised = Date.parse(alarm!.raised_at);
  const created = await page.request.post('/api/diagnosis/runs', {
    data: {
      alarm_id: alarm!.id,
      equipment_id: alarm!.equipment_id,
      window: {
        start: new Date(raised - 30 * 60_000).toISOString(),
        end: new Date(raised + 30 * 60_000).toISOString(),
      },
      symptom: alarm!.message,
    },
  });
  expect(created.status()).toBe(201);
  const runId = ((await created.json()) as { run: { id: string } }).run.id;

  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/diagnosis/runs/${runId}`);
        return ((await response.json()) as RunDetail).run.status;
      },
      { timeout: 60_000, intervals: [500, 1000] },
    )
    .toBe('awaiting_human');

  const detail = await runDetail(page, runId);
  expect(detail.report?.handoff_reason).toBeTruthy();
  expect(detail.validation?.valid).toBe(true);
  expect(
    detail.report?.hypotheses.some(
      (hypothesis) => hypothesis.code === 'insufficient_evidence',
    ),
  ).toBe(true);
  expect(
    detail.report?.recommendations.every(
      (item) => item.control_execution === 'disabled',
    ),
  ).toBe(true);

  await page.goto(`/diagnosis#/runs/${runId}`);
  await expect(page.getByText('证据不足').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/转人工原因/)).toBeVisible();
  await expect(page.getByText('控制执行禁用').first()).toBeVisible();
});
