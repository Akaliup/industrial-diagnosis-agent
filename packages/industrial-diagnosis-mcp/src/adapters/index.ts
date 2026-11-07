import fs from 'node:fs';
import type { McpConfig } from '../config.js';
import { FixtureStore } from '../store.js';
import { MockAdapter } from './mock.js';
import {
  RestAdapter,
  type RestEndpointConfig,
  type RestMapping,
} from './rest.js';
import { RootCloudAdapter } from './rootcloud.js';
import type { AdapterContext, DiagnosisAdapter } from './types.js';

const DEFAULT_ENDPOINTS: RestEndpointConfig = {
  resolve: '/equipment/resolve',
  status: '/equipment/{equipment_id}/status',
  telemetry: '/equipment/{equipment_id}/telemetry',
  alarms: '/equipment/{equipment_id}/alarms',
  mes_events: '/equipment/{equipment_id}/mes-events',
  work_orders: '/equipment/{equipment_id}/work-orders',
};

function loadMapping(): RestMapping | undefined {
  const configured = process.env.DIAGNOSIS_REST_MAPPING?.trim();
  if (!configured) return undefined;
  // 同时支持内联 JSON（模板/CI）与文件路径（企业部署）。
  if (configured.startsWith('{')) {
    return JSON.parse(configured) as RestMapping;
  }
  if (!fs.existsSync(configured)) {
    throw new Error(`DIAGNOSIS_REST_MAPPING 文件不存在：${configured}`);
  }
  return JSON.parse(fs.readFileSync(configured, 'utf8')) as RestMapping;
}

export function createAdapter(
  config: McpConfig,
  store: FixtureStore,
  ctx: AdapterContext,
): DiagnosisAdapter {
  if (config.dataMode === 'mock' || config.dataMode === 'replay') {
    return new MockAdapter(store, ctx);
  }
  const baseUrl = process.env.DIAGNOSIS_REST_BASE_URL;
  if (baseUrl) {
    const endpoints = process.env.DIAGNOSIS_REST_ENDPOINTS
      ? (JSON.parse(process.env.DIAGNOSIS_REST_ENDPOINTS) as RestEndpointConfig)
      : DEFAULT_ENDPOINTS;
    return new RestAdapter(
      {
        baseUrl,
        token: process.env.DIAGNOSIS_REST_TOKEN,
        endpoints,
        timeoutMs: Number(process.env.DIAGNOSIS_REST_TIMEOUT_MS ?? 10_000),
      },
      ctx,
      loadMapping(),
    );
  }
  return new RootCloudAdapter(ctx);
}
