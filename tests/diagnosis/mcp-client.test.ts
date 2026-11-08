import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  closeContext,
  createSeededContext,
  FIXTURES,
  type TestContext,
} from './helpers.js';
import { DiagnosisMcpClient } from '../../src/diagnosis/mcp-client.js';

let context: TestContext;

beforeAll(async () => {
  context = await createSeededContext('diagnosis-mcp-client');
}, 120_000);

afterAll(() => {
  closeContext(context);
});

describe('MCP client connection failures', () => {
  test('a server that exits during connect returns a retryable source error', async () => {
    const serverPath = path.join(context.dir, 'exiting-mcp.js');
    fs.writeFileSync(serverPath, 'process.exit(1);\n', 'utf8');
    const client = new DiagnosisMcpClient({
      workspaceId: context.workspaceId,
      runId: 'run_mcp_client_test',
      dataMode: 'mock',
      scenarioId: null,
      fixturesDir: FIXTURES,
      now: '2026-11-07T00:30:00.000Z',
      sourceAllowlist: null,
      timeoutMs: 2_000,
      callLog: null,
      serverPath,
    });
    try {
      const envelope = await client.callRaw(
        'equipment_resolve',
        { query: 'EQ-DEMO-001' },
        {
          start: '2026-11-07T00:00:00.000Z',
          end: '2026-11-07T00:30:00.000Z',
        },
      );
      // 连接阶段的异常不能穿透编排层把 Run 直接标成 failed；
      // 它应作为可重试的来源错误进入既有重试/转人工路径。
      expect(envelope.status).toBe('error');
      expect(envelope.error?.code).toBe('SOURCE_UNAVAILABLE');
      expect(envelope.error?.retryable).toBe(true);
      expect(envelope.error?.safe_message).toContain('MCP 调用失败');
    } finally {
      await client.close();
    }
  }, 30_000);
});
