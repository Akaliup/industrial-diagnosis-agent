import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  ensureDemoData,
  ensureSession,
  openDiagnosis,
  SHOTS,
} from './helpers.js';

test('core diagnosis flow renders on desktop, tablet and mobile', async ({
  page,
}) => {
  test.slow();
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureSession(page);
  await ensureDemoData(page);

  await expect(page.getByText('活动报警')).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'inbox-1440x900.png'),
  });

  await openDiagnosis(page);
  await expect(page.getByText('候选根因')).toBeVisible();
  await expect(page.getByText('关键观察')).toBeVisible();
  await expect(page.getByText('人工复核')).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'workbench-1440x900.png'),
  });

  const chip = page
    .getByRole('button')
    .filter({ hasText: /^ev_[a-f0-9]+$/ })
    .first();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'evidence-drawer-1440x900.png'),
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.goto('/diagnosis#/reviews');
  await expect(page.getByRole('heading', { name: '复核与审批' })).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'reviews-1440x900.png'),
  });

  await page.goto('/diagnosis#/eval');
  await expect(page.getByRole('heading', { name: '评测与回放' })).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'eval-1440x900.png'),
  });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/diagnosis#/inbox');
  await expect(page.getByRole('heading', { name: '报警收件箱' })).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'inbox-1024x768.png'),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/diagnosis#/inbox');
  await expect(page.getByRole('heading', { name: '报警收件箱' })).toBeVisible();
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'mobile-nav-390x844.png'),
  });
  await page.keyboard.press('Escape');

  const bodyWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(bodyWidth).toBeLessThanOrEqual(390 + 1);
});

test('human review accepts a pending diagnosis and locks the form', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureSession(page);
  await ensureDemoData(page);

  const runsResponse = await page.request.get('/api/diagnosis/runs');
  expect(runsResponse.ok()).toBeTruthy();
  const runsBody = (await runsResponse.json()) as {
    runs: Array<{ id: string; status: string; review_status: string }>;
  };
  let pending = runsBody.runs.find(
    (run) => run.status === 'awaiting_human' && run.review_status === 'pending',
  );

  if (!pending) {
    // 复用已有待复核任务；没有则通过 API 发起一个必然转人工的场景。
    const resumable = runsBody.runs.find(
      (run) => run.status === 'awaiting_human',
    );
    if (resumable) {
      const resumed = await page.request.post(
        `/api/diagnosis/runs/${resumable.id}/resume`,
        { data: { note: 'E2E review flow check' } },
      );
      expect(resumed.status()).toBe(201);
      pending = (await resumed.json()).run;
    } else {
      const alarmsResponse = await page.request.get('/api/diagnosis/alarms');
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
      pending = (await created.json()).run;
    }
  }

  if (
    pending &&
    pending.status === 'awaiting_human' &&
    pending.review_status !== 'pending'
  ) {
    // 本地重复运行时，源超时场景可能已被复核；续诊会生成新的待复核任务。
    const resumed = await page.request.post(
      `/api/diagnosis/runs/${pending.id}/resume`,
      { data: { note: 'E2E review flow check' } },
    );
    expect(resumed.status()).toBe(201);
    pending = (await resumed.json()).run;
  }

  expect(pending).toBeTruthy();
  const runId = pending!.id;

  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/diagnosis/runs/${runId}`);
        const body = (await response.json()) as {
          run: { status: string; review_status: string };
        };
        return `${body.run.status}/${body.run.review_status}`;
      },
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toBe('awaiting_human/pending');

  await page.goto(`/diagnosis#/runs/${runId}`);
  await expect(page.getByText('人工复核').first()).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByPlaceholder(/复核意见/)
    .fill('E2E：现场复核确认结论与证据链一致。');
  await page.getByRole('button', { name: '提交复核' }).click();

  await expect(page.getByText('复核已完成。', { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('已复核 · 接受').first()).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS, 'review-submitted-1440x900.png'),
  });
});
