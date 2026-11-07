#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { FixtureStore } from './store.js';
import { createAdapter } from './adapters/index.js';
import { createToolDefinitions } from './tools.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new FixtureStore(config);
  const adapter = createAdapter(config, store, {
    workspaceId: config.workspaceId,
    runId: config.runId,
    dataMode: config.dataMode,
    now: config.now,
    sourceAllowlist: config.sourceAllowlist,
  });
  const server = new McpServer({
    name: 'industrial-diagnosis-mcp',
    version: '0.1.0',
  });

  for (const def of createToolDefinitions(config, adapter)) {
    server.registerTool(
      def.name,
      {
        title: def.name,
        description: def.description,
        inputSchema: def.schema,
      },
      async (args: unknown) => {
        const envelope = await def.run(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope as unknown as Record<string, unknown>,
          isError: envelope.status === 'error',
        };
      },
    );
  }

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[diagnosis-mcp] ready mode=${config.dataMode} scenario=${config.scenarioId ?? 'base'} workspace=${config.workspaceId} run=${config.runId}\n`,
  );

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(
    `[diagnosis-mcp] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
