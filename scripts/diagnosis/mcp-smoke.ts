/**
 * MCP 真实 transport 冒烟：启动独立子进程，发现工具、调用工具、读取统一返回。
 * 用法：npx tsx scripts/diagnosis/mcp-smoke.ts [scenario]
 */
import '../../src/diagnosis/load-env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const scenario = process.argv[2] ?? 'demo-sensor-drift';

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'packages/industrial-diagnosis-mcp/dist/server.js')],
    env: {
      ...process.env,
      DIAGNOSIS_WORKSPACE_ID: 'ws_demo',
      DIAGNOSIS_RUN_ID: 'run_smoke',
      DIAGNOSIS_DATA_MODE: 'mock',
      DIAGNOSIS_FIXTURES_DIR: path.join(ROOT, 'fixtures/diagnosis'),
      DIAGNOSIS_SCENARIO_ID: scenario,
      DIAGNOSIS_NOW: '2026-11-07T00:30:00Z',
      DIAGNOSIS_MCP_CALL_LOG: path.join(
        ROOT,
        'work/diagnosis/logs/mcp-calls.jsonl',
      ),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'diagnosis-smoke', version: '0.1.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('tools:', tools.tools.map((t) => t.name).join(', '));
  const result = await client.callTool({
    name: 'equipment_query',
    arguments: {
      equipment_id: 'EQ-DEMO-001',
      query_kind: 'telemetry',
      window: {
        start: '2026-11-07T00:00:00Z',
        end: '2026-11-07T00:30:00Z',
      },
      metrics: ['bearing_temperature', 'vibration_rms', 'motor_current'],
      limit: 1000,
    },
  });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === 'text')?.text ?? '{}';
  const envelope = JSON.parse(text) as {
    status: string;
    evidence: unknown[];
    data: { stats?: Array<{ metric: string; min: number; max: number }> };
    coverage: unknown;
  };
  console.log('status:', envelope.status);
  console.log('evidence:', envelope.evidence.length);
  console.log('stats:', JSON.stringify(envelope.data?.stats ?? null));
  console.log('coverage:', JSON.stringify(envelope.coverage));
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
