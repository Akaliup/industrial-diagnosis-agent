import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const SHOTS = path.resolve(
  process.cwd(),
  '../docs/diagnosis/screenshots',
);
export const ADMIN = {
  username: process.env.DIAGNOSIS_E2E_ADMIN_USER ?? 'e2e_admin',
  password: process.env.DIAGNOSIS_E2E_ADMIN_PASSWORD ?? 'E2ePass123!',
};
export const DEMO = {
  username: process.env.DIAGNOSIS_E2E_USER ?? 'demo',
  password: process.env.DIAGNOSIS_E2E_PASSWORD ?? 'DemoPass123!',
};

export async function visible(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

export async function login(page: Page, username: string, password: string) {
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

export async function ensureSession(page: Page): Promise<void> {
  await page.goto('/diagnosis#/inbox');
  await page.waitForLoadState('networkidle');

  if (
    await page
      .getByRole('heading', { name: '创建管理员账户' })
      .isVisible()
      .catch(() => false)
  ) {
    await page.locator('#setup-username').fill(ADMIN.username);
    await page.locator('#setup-password').fill(ADMIN.password);
    await page.locator('#setup-confirm').fill(ADMIN.password);
    await page.getByRole('button', { name: '创建并进入工作台' }).click();
  } else if (await visible(page, '#username')) {
    await login(page, DEMO.username, DEMO.password);
    await page.waitForTimeout(800);
    if (await visible(page, '#username')) {
      await login(page, ADMIN.username, ADMIN.password);
    }
  }

  await expect(page.getByRole('heading', { name: '报警收件箱' })).toBeVisible({
    timeout: 30_000,
  });
}

export async function ensureDemoData(page: Page): Promise<void> {
  const seed = page.getByRole('button', { name: '载入演示数据' });
  if (await seed.isVisible().catch(() => false)) {
    // 按钮在请求期间会变成“正在载入…”，不能只等按钮消失；必须等种子请求完成。
    const seeded = page.waitForResponse(
      (response) =>
        response.url().includes('/api/diagnosis/demo/seed') &&
        response.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await seed.click();
    expect((await seeded).ok()).toBeTruthy();
    await page.reload();
    await page.waitForLoadState('networkidle');
  }
  await expect(
    page.getByText(/DEMO-BRG-01|DEMO-COMM-03|DEMO-VIB-02/).first(),
  ).toBeVisible({ timeout: 30_000 });
}

export async function openDiagnosis(page: Page): Promise<void> {
  // 优先打开 1 号循环泵的传感器漂移场景，报告中会有完整的支持/反证链。
  const row = page
    .locator('div.group')
    .filter({ hasText: '1号循环泵' })
    .filter({ hasText: 'DEMO-BRG-01' })
    .first();
  await expect(row).toBeVisible();
  const start = row.getByRole('button', { name: '开始诊断' });
  if ((await start.count()) > 0) {
    await start.click();
    await expect(page.getByRole('heading', { name: '发起诊断' })).toBeVisible();
    await page.getByRole('button', { name: '开始诊断' }).click();
  } else {
    await row.getByRole('link', { name: /查看诊断/ }).click();
  }
  await expect(page.getByText('诊断结论').first()).toBeVisible({
    timeout: 45_000,
  });
}
