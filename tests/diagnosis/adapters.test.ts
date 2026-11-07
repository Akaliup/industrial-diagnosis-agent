import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RestAdapter } from '../../packages/industrial-diagnosis-mcp/src/adapters/rest.js';
import { RootCloudAdapter } from '../../packages/industrial-diagnosis-mcp/src/adapters/rootcloud.js';

const CTX = {
  workspaceId: 'web:main',
  runId: 'run_adapter_test',
  dataMode: 'live' as const,
  now: '2026-11-07T00:00:00.000Z',
  sourceAllowlist: null,
};

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string; seen: Array<{ url: string; auth?: string }> }> {
  const seen: Array<{ url: string; auth?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, seen };
}

function adapter(baseUrl: string): RestAdapter {
  return new RestAdapter(
    {
      baseUrl,
      token: 'test-token',
      endpoints: {
        resolve: '/equipment/resolve',
        status: '/equipment/{equipment_id}/status',
        telemetry: '/equipment/{equipment_id}/telemetry',
        alarms: '/equipment/{equipment_id}/alarms',
        mes_events: '/equipment/{equipment_id}/mes-events',
        work_orders: '/equipment/{equipment_id}/work-orders',
      },
      timeoutMs: 2000,
    },
    CTX,
    { fields: { points: 'data.points' } },
  );
}

describe('REST adapter contract', () => {
  it('resolves one equipment and forwards the configured bearer token', async () => {
    const { baseUrl, seen } = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ matches: [{ equipment_id: 'EQ-1' }] }));
    });
    const result = await adapter(baseUrl).resolveEquipment({ query: 'EQ-1' });
    expect(result.status).toBe('success');
    expect(result.data?.matches).toHaveLength(1);
    expect(seen[0]?.auth).toBe('Bearer test-token');
    expect(seen[0]?.url).toContain('/equipment/resolve?query=EQ-1');
  });

  it('maps configured dot paths and keeps the source data as evidence-free payload', async () => {
    const { baseUrl, seen } = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: { points: [{ metric: 'bearing_temperature', value: 70 }] },
        }),
      );
    });
    const result = await adapter(baseUrl).query({
      equipment_id: 'EQ-1',
      query_kind: 'status',
      window: {
        start: '2026-11-07T00:00:00Z',
        end: '2026-11-07T00:30:00Z',
      },
    });
    expect(result.status).toBe('success');
    expect((result.data as { points?: unknown[] } | null)?.points).toHaveLength(
      1,
    );
    expect(result.warnings.map((item) => item.code)).toContain(
      'EVIDENCE_NOT_INGESTED',
    );
    expect(seen[0]?.url).toContain('/equipment/EQ-1/status');
    expect(seen[0]?.url).toContain('start=2026-11-07T00%3A00%3A00Z');
  });

  it('surfaces upstream failures as retryable SOURCE_UNAVAILABLE', async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end('down');
    });
    const result = await adapter(baseUrl).query({
      equipment_id: 'EQ-1',
      query_kind: 'alarms',
      window: {
        start: '2026-11-07T00:00:00Z',
        end: '2026-11-07T00:30:00Z',
      },
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('SOURCE_UNAVAILABLE');
    expect(result.error?.retryable).toBe(true);
  });
});

describe('RootCloud adapter without enterprise contract', () => {
  it('returns UNCONFIGURED and never fabricates an endpoint or signature', async () => {
    const result = await new RootCloudAdapter(CTX).resolveEquipment({
      query: 'EQ-1',
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('UNCONFIGURED');
    expect(result.data).toBeNull();
    expect(result.warnings[0]?.code).toBe('ROOTCLOUD_UNCONFIGURED');
  });
});
