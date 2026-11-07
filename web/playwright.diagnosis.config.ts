import { defineConfig } from '@playwright/test';

const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

/**
 * 设备智诊端到端测试。
 *
 * 依赖已构建的 web/dist 与诊断服务（默认 127.0.0.1:3100）。
 * 本地已有服务时复用；CI 中由 webServer 启动。
 */
export default defineConfig({
  testDir: './tests/e2e/diagnosis',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: systemChromium
      ? { executablePath: systemChromium }
      : undefined,
  },
  webServer: {
    command: 'npm --prefix .. run diagnosis:server',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
