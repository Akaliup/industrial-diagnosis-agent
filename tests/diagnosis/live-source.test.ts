import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  closeContext,
  createSeededContext,
  isoPlus,
  type TestContext,
} from './helpers.js';
import { DEFAULT_BUDGET } from '../../src/diagnosis/contracts/domain.js';
import {
  liveSourcesReady,
  testLiveSource,
} from '../../src/diagnosis/source-health.js';
import { newId } from '../../src/diagnosis/util.js';

let context: TestContext;
let server: http.Server;
const requests: string[] = [];

beforeAll(async () => {
  context = await createSeededContext('diagnosis-live-source');
  server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'application/json');
    if ((request.url ?? '').startsWith('/equipment/resolve')) {
      response.end(
        JSON.stringify({
          matches: [
            {
              equipment_id: 'EQ-DEMO-001',
              name: '1号循环泵',
              vendor: 'Northwind Pumps',
              model: 'NP-200',
              serial: 'NP200-2023-001',
              source_ids: { scada: 'EQ-DEMO-001' },
            },
          ],
        }),
      );
      return;
    }
    response.end(JSON.stringify({}));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  process.env.DIAGNOSIS_REST_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.DIAGNOSIS_REST_TOKEN = 'local-test-token';
}, 120_000);

afterAll(async () => {
  delete process.env.DIAGNOSIS_REST_BASE_URL;
  delete process.env.DIAGNOSIS_REST_TOKEN;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeContext(context);
});

describe('live source configuration', () => {
  test('tests a local fake REST source, flips status and runs without external network', async () => {
    context.repo.upsertSource(context.workspaceId, {
      id: 'src-live-fake',
      workspace_id: context.workspaceId,
      kind: 'scada',
      name: '本地假 REST',
      data_mode: 'live',
      status: 'unconfigured',
      auth_kind: 'bearer',
      last_test_at: null,
      last_test_ok: null,
      notes: '',
    });
    const source = context.repo
      .listSources(context.workspaceId)
      .find((item) => item.id === 'src-live-fake')!;
    const equipment = context.repo.getEquipment(
      context.workspaceId,
      'EQ-DEMO-001',
    )!;

    const health = await testLiveSource({
      source,
      equipmentId: equipment.equipment_id,
      timeoutMs: 2_000,
    });
    expect(health.ok, health.message).toBe(true);
    expect(requests.some((url) => url.startsWith('/equipment/resolve'))).toBe(
      true,
    );

    context.repo.updateSourceTest(
      context.workspaceId,
      source.id,
      health.ok,
      health.message,
    );
    context.repo.updateSourceStatus(
      context.workspaceId,
      source.id,
      health.ok ? 'configured' : 'unconfigured',
    );
    expect(
      liveSourcesReady(context.repo, context.workspaceId).map(
        (item) => item.id,
      ),
    ).toContain('src-live-fake');

    const alarm = context.repo
      .listAlarms(context.workspaceId)
      .find((item) => item.source_alarm_id === 'ALM-demo-sensor-drift')!;
    const start = '2026-11-07T00:00:00.000Z';
    const run = context.repo.createRun({
      id: newId('run'),
      workspaceId: context.workspaceId,
      userId: 'live-test',
      alarmId: alarm.id,
      equipmentId: 'EQ-DEMO-001',
      window: { start, end: isoPlus(start, 30) },
      symptom: '1号循环泵轴承温度持续上升，振动与电流稳定',
      dataMode: 'live',
      modelMode: 'fixture',
      budget: DEFAULT_BUDGET,
      scenarioId: 'demo-sensor-drift',
    });
    context.repo.appendEvent(run.id, 'run.created', {
      workspace_id: context.workspaceId,
      data_mode: 'live',
    });

    const finished = await context.orchestrator.execute(run.id, {
      owner: 'live-test',
    });
    expect(finished.status).toBe('awaiting_human');
    expect(
      requests.some((url) => url.startsWith('/equipment/EQ-DEMO-001/status')),
    ).toBe(true);
    const report = context.repo.getReport(run.id);
    expect(report).not.toBeNull();
    expect(report!.report.handoff_reason).toBeTruthy();
    expect(report!.report.limitations.join(' ')).toMatch(/Mock|模拟|REST|真实/);
  }, 120_000);
});
