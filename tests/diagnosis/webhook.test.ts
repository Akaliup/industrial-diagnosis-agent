import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DiagnosisRuntime } from '../../src/diagnosis/runtime.js';
import { createDiagnosisRoutes } from '../../src/diagnosis/routes.js';

const FIXTURES = path.resolve(process.cwd(), 'fixtures/diagnosis');
const WORKSPACE = 'ws-webhook-test';
const SOURCE = 'src-scada';
const SECRET = 'test-webhook-secret';

let dir: string;
let db: Database.Database;
let runtime: DiagnosisRuntime;
let app: ReturnType<typeof createDiagnosisRoutes>;

function body(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: WORKSPACE,
    source_id: SOURCE,
    source_alarm_id: 'ALM-WEBHOOK-1',
    equipment_id: 'EQ-DEMO-001',
    code: 'DEMO-BRG-01',
    severity: 'high',
    state: 'active',
    raised_at: '2026-11-07T05:00:00.000Z',
    cleared_at: null,
    message: 'Webhook 报警',
    ...overrides,
  };
}

function signedHeaders(raw: string, timestamp = new Date().toISOString()) {
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`${timestamp}.${WORKSPACE}.${raw}`)
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-diagnosis-timestamp': timestamp,
    'x-diagnosis-signature': `sha256=${signature}`,
  };
}

async function post(payload: unknown, headers: Record<string, string>) {
  return app.request('/alarm-events', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnosis-webhook-'));
  db = new Database(path.join(dir, 'webhook.db'));
  db.pragma('journal_mode = WAL');
  runtime = new DiagnosisRuntime(db, {
    fixturesDir: FIXTURES,
    modelMode: 'fixture',
    dataMode: 'mock',
    startWorker: false,
  });
  await runtime.seed(WORKSPACE, 'mock');
  app = createDiagnosisRoutes(runtime);
}, 120_000);

afterAll(() => {
  delete process.env.DIAGNOSIS_WEBHOOK_SECRETS;
  try {
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('alarm webhook', () => {
  test('refuses unsigned alarms when no secret is configured', async () => {
    delete process.env.DIAGNOSIS_WEBHOOK_SECRETS;
    const raw = body();
    const response = await post(raw, {
      'content-type': 'application/json',
    });
    expect(response.status).toBe(503);
    const json = (await response.json()) as { error: { code: string } };
    expect(json.error.code).toBe('WEBHOOK_UNCONFIGURED');
  });

  test('rejects missing, stale and invalid signatures without writing', async () => {
    process.env.DIAGNOSIS_WEBHOOK_SECRETS = JSON.stringify({
      [`${WORKSPACE}:${SOURCE}`]: SECRET,
    });
    const before = runtime.repo.listAlarms(WORKSPACE).length;
    const raw = body();

    const missing = await post(raw, { 'content-type': 'application/json' });
    expect(missing.status).toBe(401);

    const stale = await post(
      raw,
      signedHeaders(
        JSON.stringify(raw),
        new Date(Date.now() - 10 * 60_000).toISOString(),
      ),
    );
    expect(stale.status).toBe(401);

    const headers = signedHeaders(JSON.stringify(raw));
    headers['x-diagnosis-signature'] = 'sha256=deadbeef';
    const invalid = await post(raw, headers);
    expect(invalid.status).toBe(401);
    expect(runtime.repo.listAlarms(WORKSPACE).length).toBe(before);
  });

  test('accepts a valid signature and deduplicates retries', async () => {
    process.env.DIAGNOSIS_WEBHOOK_SECRETS = JSON.stringify({
      [`${WORKSPACE}:${SOURCE}`]: SECRET,
    });
    const raw = body();
    const text = JSON.stringify(raw);
    const first = await post(raw, signedHeaders(text));
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as {
      created: boolean;
      alarm: { id: string };
    };
    expect(firstJson.created).toBe(true);

    const second = await post(raw, signedHeaders(text));
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      created: boolean;
      alarm: { id: string };
    };
    expect(secondJson.created).toBe(false);
    expect(secondJson.alarm.id).toBe(firstJson.alarm.id);
  });

  test('rejects unknown fields and unknown equipment', async () => {
    process.env.DIAGNOSIS_WEBHOOK_SECRETS = JSON.stringify({
      [`${WORKSPACE}:${SOURCE}`]: SECRET,
    });
    const extra = body({ execute_control: true });
    const extraResponse = await post(
      extra,
      signedHeaders(JSON.stringify(extra)),
    );
    expect(extraResponse.status).toBe(400);

    const unknown = body({ equipment_id: 'EQ-MISSING' });
    const unknownResponse = await post(
      unknown,
      signedHeaders(JSON.stringify(unknown)),
    );
    expect(unknownResponse.status).toBe(404);
  });
});
