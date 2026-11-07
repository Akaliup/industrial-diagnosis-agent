import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { getAllCookieValues, tryVerifyAny } from '../middleware/auth.js';
import {
  canAccessGroup,
  getCachedSessionWithUser,
  invalidateSessionCache,
} from '../web-context.js';
import { getRegisteredGroup, deleteUserSession } from '../db.js';
import { isSessionExpired } from '../auth.js';
import {
  LEGACY_SESSION_COOKIE_NAME_PLAIN,
  LEGACY_SESSION_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME_PLAIN,
  SESSION_COOKIE_NAME_SECURE,
} from '../config.js';
import type { DiagnosisRuntime } from './runtime.js';

function allowedOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    if (new URL(origin).host === host) return true;
  } catch {
    return false;
  }
  const extra = (process.env.DIAGNOSIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return extra.includes(origin);
}

function reject(socket: import('node:stream').Duplex, status: string): void {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}

/**
 * 挂载 `/ws/diagnosis?run_id=...&after_seq=...`。
 *
 * 认证复用 Miniclaw 会话 Cookie；每个事件都带 Run 内单调 seq，客户端断线后
 * 用 after_seq 补拉。先订阅再读 backlog，backlog 发送期间的事件先缓冲，
 * 避免重连时丢事件或乱序。
 */
export function attachDiagnosisWebSocket(
  server: Server,
  runtime: DiagnosisRuntime,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    } catch {
      return;
    }
    if (url.pathname !== '/ws/diagnosis') return;
    if (!allowedOrigin(request.headers.origin, request.headers.host)) {
      reject(socket, '403 Forbidden');
      return;
    }
    const cookieHeader = request.headers.cookie;
    const values = [
      ...getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_SECURE),
      ...getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_PLAIN),
      ...getAllCookieValues(cookieHeader, LEGACY_SESSION_COOKIE_NAME_SECURE),
      ...getAllCookieValues(cookieHeader, LEGACY_SESSION_COOKIE_NAME_PLAIN),
    ];
    if (values.length === 0) {
      reject(socket, '401 Unauthorized');
      return;
    }
    const verified = tryVerifyAny(values);
    if (!verified) {
      reject(socket, '401 Unauthorized');
      return;
    }
    const session = getCachedSessionWithUser(verified.token);
    if (!session) {
      invalidateSessionCache(verified.token);
      reject(socket, '401 Unauthorized');
      return;
    }
    if (isSessionExpired(session.expires_at)) {
      deleteUserSession(verified.token);
      invalidateSessionCache(verified.token);
      reject(socket, '401 Unauthorized');
      return;
    }
    if (session.status !== 'active') {
      reject(socket, '403 Forbidden');
      return;
    }
    const runId = url.searchParams.get('run_id');
    if (!runId) {
      reject(socket, '400 Bad Request');
      return;
    }
    const run = runtime.repo.getRun(runId);
    if (!run) {
      reject(socket, '404 Not Found');
      return;
    }
    const group = getRegisteredGroup(run.workspace_id);
    if (
      !group ||
      !canAccessGroup({ id: session.user_id, role: session.role }, group)
    ) {
      reject(socket, '403 Forbidden');
      return;
    }
    const afterSeq = Number(url.searchParams.get('after_seq') ?? 0);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, { runId, afterSeq, userId: session.user_id });
    });
  });

  wss.on(
    'connection',
    (
      ws: WebSocket,
      context: { runId: string; afterSeq: number; userId: string },
    ) => {
      let ready = false;
      let lastSeq = Number.isFinite(context.afterSeq) ? context.afterSeq : 0;
      const buffered: Array<Record<string, unknown>> = [];
      const send = (event: Record<string, unknown>): void => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const seq = Number(event.seq ?? 0);
        if (seq <= lastSeq) return;
        lastSeq = seq;
        ws.send(JSON.stringify({ type: 'event', event }));
      };
      const unsubscribe = runtime.bus.subscribe(context.runId, (event) => {
        if (!ready) buffered.push(event as unknown as Record<string, unknown>);
        else send(event as unknown as Record<string, unknown>);
      });
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() }),
          );
        }
      }, 30_000);
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString('utf8')) as {
            type?: string;
          };
          if (message.type === 'ping') {
            ws.send(
              JSON.stringify({ type: 'pong', at: new Date().toISOString() }),
            );
          }
        } catch {
          /* 忽略非 JSON 客户端消息 */
        }
      });
      ws.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      ws.on('error', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      const backlog = runtime.repo.listEvents(
        context.runId,
        Number.isFinite(context.afterSeq) ? context.afterSeq : 0,
        500,
      );
      for (const event of backlog) {
        const seq = event.seq;
        if (seq <= lastSeq) continue;
        lastSeq = seq;
        ws.send(JSON.stringify({ type: 'event', event }));
      }
      ready = true;
      for (const event of buffered) send(event);
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          run_id: context.runId,
          last_seq: lastSeq,
        }),
      );
    },
  );

  return wss;
}
