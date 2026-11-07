import path from 'node:path';

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export interface McpConfig {
  workspaceId: string;
  runId: string;
  dataMode: 'mock' | 'replay' | 'live';
  fixturesDir: string;
  scenarioId: string | null;
  now: string;
  sourceAllowlist: string[] | null;
  callLog: string | null;
}

export function loadConfig(): McpConfig {
  const mode = env('DIAGNOSIS_DATA_MODE') ?? 'mock';
  if (mode !== 'mock' && mode !== 'replay' && mode !== 'live') {
    throw new Error(
      `DIAGNOSIS_DATA_MODE 必须是 mock/replay/live，收到 ${mode}`,
    );
  }
  const allow = env('DIAGNOSIS_SOURCE_ALLOWLIST');
  return {
    workspaceId: env('DIAGNOSIS_WORKSPACE_ID') ?? 'ws_demo',
    runId: env('DIAGNOSIS_RUN_ID') ?? 'run_mcp',
    dataMode: mode,
    fixturesDir:
      env('DIAGNOSIS_FIXTURES_DIR') ??
      path.resolve(process.cwd(), 'fixtures/diagnosis'),
    scenarioId: env('DIAGNOSIS_SCENARIO_ID') ?? null,
    now: env('DIAGNOSIS_NOW') ?? new Date().toISOString(),
    sourceAllowlist: allow
      ? allow
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    callLog: env('DIAGNOSIS_MCP_CALL_LOG') ?? null,
  };
}
