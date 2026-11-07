import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import authRoutes from '../routes/auth.js';
import { closeDatabase, getDatabaseInstance, initDatabase } from '../db.js';
import { diagnosisSchemaVersion } from './db.js';
import { createDiagnosisRoutes } from './routes.js';
import {
  DiagnosisRuntime,
  dataModeFromEnv,
  modelModeFromEnv,
} from './runtime.js';
import { attachDiagnosisWebSocket } from './ws.js';

const PORT = Number(process.env.DIAGNOSIS_PORT ?? 3100);
const HOST = process.env.DIAGNOSIS_HOST ?? '127.0.0.1';
const WEB_DIST = path.resolve(process.env.DIAGNOSIS_WEB_DIST ?? 'web/dist');

function log(message: string): void {
  console.log(`[diagnosis] ${message}`);
}

function buildApp(runtime: DiagnosisRuntime): Hono {
  const app = new Hono();

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      service: 'industrial-diagnosis',
      schema_version: diagnosisSchemaVersion(getDatabaseInstance()),
      model_mode: runtime.modelMode,
      data_mode: runtime.dataMode,
      fts_tokenizer: runtime.ftsTokenizer,
      live_eval: 'NOT_RUN',
      control_execution: 'disabled',
    }),
  );

  app.route('/api/auth', authRoutes);
  app.route('/api/diagnosis', createDiagnosisRoutes(runtime));

  app.get('/', (c) => c.redirect('/diagnosis'));
  app.get(
    '/diagnosis',
    serveStatic({ path: path.join(WEB_DIST, 'diagnosis.html') }),
  );
  app.get(
    '/diagnosis/*',
    serveStatic({ path: path.join(WEB_DIST, 'diagnosis.html') }),
  );
  app.use('/assets/*', serveStatic({ root: WEB_DIST }));
  app.use('/fonts/*', serveStatic({ root: WEB_DIST }));
  app.use('/icons/*', serveStatic({ root: WEB_DIST }));
  app.use('/favicon.svg', serveStatic({ root: WEB_DIST }));
  app.use('/favicon.ico', serveStatic({ root: WEB_DIST }));
  app.use('/manifest.webmanifest', serveStatic({ root: WEB_DIST }));
  app.use('/sw.js', serveStatic({ root: WEB_DIST }));

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: '接口不存在' } },
        404,
      );
    }
    return c.text('Not Found', 404);
  });

  return app;
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(WEB_DIST, 'diagnosis.html'))) {
    log(
      `警告：未找到 ${path.join(WEB_DIST, 'diagnosis.html')}；先运行 npm run build:web 或使用 Vite 开发服务器。`,
    );
  }
  initDatabase();
  const runtime = new DiagnosisRuntime(getDatabaseInstance(), {
    fixturesDir: process.env.DIAGNOSIS_FIXTURES_DIR ?? 'fixtures/diagnosis',
    modelMode: modelModeFromEnv(),
    dataMode: dataModeFromEnv(),
    startWorker: true,
    workerConcurrency: Number(process.env.DIAGNOSIS_WORKER_CONCURRENCY ?? 2),
    leaseMs: Number(process.env.DIAGNOSIS_LEASE_MS ?? 30_000),
    logDir: process.env.DIAGNOSIS_LOG_DIR ?? 'work/diagnosis/logs',
  });
  const app = buildApp(runtime);
  const server = serve(
    {
      fetch: app.fetch,
      port: PORT,
      hostname: HOST,
      serverOptions: {
        requestTimeout: 10 * 60 * 1000,
        headersTimeout: 60 * 1000,
      },
    },
    (info) => {
      log(`listening on http://${HOST}:${info.port}/diagnosis`);
      log(
        `model_mode=${runtime.modelMode} data_mode=${runtime.dataMode} fts=${runtime.ftsTokenizer ?? 'none'} control_execution=disabled`,
      );
    },
  ) as unknown as Server;
  const wss = attachDiagnosisWebSocket(server, runtime);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在停止 Worker 与 WebSocket...`);
    try {
      wss.close();
    } catch {
      /* ignore */
    }
    await runtime.close();
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[diagnosis] 启动失败', error);
  process.exitCode = 1;
});
