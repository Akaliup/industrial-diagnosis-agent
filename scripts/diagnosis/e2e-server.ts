/**
 * 设备智诊 E2E 专用服务入口。
 *
 * 每次启动前清空并重建 work/diagnosis/e2e-data，使用独立的 Miniclaw 数据目录，
 * 因此不会读取或修改本地演示库 data/，也不依赖已有用户、默认密码或已启动服务。
 * 端口由 DIAGNOSIS_E2E_PORT 指定（默认 3199）。
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const root = process.cwd();
const workRoot = path.join(root, 'work/diagnosis');
const dataDir = path.resolve(
  process.env.DIAGNOSIS_E2E_DATA_DIR ?? path.join(workRoot, 'e2e-data'),
);

const relative = path.relative(workRoot, dataDir);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
  throw new Error(`拒绝清理非诊断工作目录：${dataDir}`);
}

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

process.env.MINICLAW_DATA_DIR = dataDir;
process.env.DIAGNOSIS_HOST = '127.0.0.1';
process.env.DIAGNOSIS_PORT = process.env.DIAGNOSIS_E2E_PORT ?? '3199';
process.env.DIAGNOSIS_MODEL_MODE ??= 'fixture';
process.env.DIAGNOSIS_DATA_MODE ??= 'mock';
process.env.DIAGNOSIS_LOG_DIR ??= path.join(workRoot, 'e2e-logs');
// 仅 E2E 允许按 Run 指定固定场景；普通部署保持默认拒绝。
process.env.DIAGNOSIS_ALLOW_SCENARIOS = '1';
// E2E 专用固定密钥；仅用于本地/CI 的签名校验测试，不包含任何真实凭据。
process.env.DIAGNOSIS_WEBHOOK_SECRETS ??= JSON.stringify({
  'src-scada': 'e2e-webhook-secret',
});

// 本机假 REST 服务：只用于证明“配置→测试→状态→Run”链路，不访问外网。
const fakeRest = http.createServer((request, response) => {
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
  fakeRest.listen(0, '127.0.0.1', resolve);
});
const fakeRestPort = (fakeRest.address() as AddressInfo).port;
process.env.DIAGNOSIS_REST_BASE_URL ??= `http://127.0.0.1:${fakeRestPort}`;
process.env.DIAGNOSIS_REST_TOKEN ??= 'e2e-local-token';

// server.ts 在模块加载时读取端口并启动；必须先设置环境变量再动态导入。
await import('../../src/diagnosis/server.js');
