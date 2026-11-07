import { defineConfig } from '@playwright/test';

const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const port = Number(process.env.DIAGNOSIS_E2E_PORT ?? 3199);
const baseURL = `http://127.0.0.1:${port}`;

/**
 * 设备智诊端到端测试。
 *
 * 每次运行都由 scripts/diagnosis/e2e-server.ts 在 work/diagnosis/e2e-data
 * 建立独立数据目录并从空库启动，不复用本地已运行的服务或演示数据库。
 * 依赖已构建的 web/dist 与 MCP dist。
 */
export default defineConfig({
  testDir: './tests/e2e/diagnosis',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  reporter: 'line',
  outputDir: 'test-results/diagnosis',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: systemChromium
      ? { executablePath: systemChromium }
      : undefined,
  },
  webServer: {
    command: 'npm --prefix .. run diagnosis:e2e:server',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { DIAGNOSIS_E2E_PORT: String(port) },
  },
});
