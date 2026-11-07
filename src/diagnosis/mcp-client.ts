import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ToolResponseEnvelopeSchema,
  type DataMode,
  type ErrorCode,
  type ToolResponseEnvelope,
  type Window,
} from './contracts/domain.js';
import { sleep } from './util.js';

export interface McpClientOptions {
  workspaceId: string;
  runId: string;
  dataMode: DataMode;
  scenarioId: string | null;
  fixturesDir: string;
  now: string;
  sourceAllowlist: string[] | null;
  timeoutMs: number;
  callLog: string | null;
  serverPath?: string;
}

export interface CallAttempt {
  attempt: number;
  envelope: ToolResponseEnvelope;
  durationMs: number;
}

function errorEnvelope(
  code: ErrorCode,
  message: string,
  retryable: boolean,
  window: Window,
  dataMode: DataMode = 'mock',
): ToolResponseEnvelope {
  return {
    schema_version: '1',
    request_id: `req_${Date.now()}`,
    logical_call_id: `lc_${Date.now()}`,
    data_mode: dataMode,
    status: 'error',
    data: null,
    evidence: [],
    coverage: {
      from: window.start,
      to: window.end,
      complete: false,
      missing: [code],
    },
    warnings: [],
    error: { code, retryable, safe_message: message },
    next_cursor: null,
  };
}

export class DiagnosisMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private stderrTail = '';

  constructor(private readonly options: McpClientOptions) {}

  private serverPath(): string {
    return (
      this.options.serverPath ??
      process.env.DIAGNOSIS_MCP_SERVER ??
      path.resolve(
        process.cwd(),
        'packages/industrial-diagnosis-mcp/dist/server.js',
      )
    );
  }

  async ensureConnected(): Promise<void> {
    if (this.client) return;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.serverPath()],
      env: {
        ...process.env,
        DIAGNOSIS_WORKSPACE_ID: this.options.workspaceId,
        DIAGNOSIS_RUN_ID: this.options.runId,
        DIAGNOSIS_DATA_MODE: this.options.dataMode,
        DIAGNOSIS_FIXTURES_DIR: this.options.fixturesDir,
        DIAGNOSIS_NOW: this.options.now,
        ...(this.options.scenarioId
          ? { DIAGNOSIS_SCENARIO_ID: this.options.scenarioId }
          : {}),
        ...(this.options.sourceAllowlist
          ? {
              DIAGNOSIS_SOURCE_ALLOWLIST:
                this.options.sourceAllowlist.join(','),
            }
          : {}),
        ...(this.options.callLog
          ? { DIAGNOSIS_MCP_CALL_LOG: this.options.callLog }
          : {}),
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(
        -4000,
      );
    });
    const client = new Client({
      name: 'industrial-diagnosis',
      version: '0.1.0',
    });
    try {
      await client.connect(transport);
    } catch (error) {
      // 连接失败必须清理半开进程，否则下一次重试会复用坏连接。
      try {
        await transport.close();
      } catch {
        // 忽略关闭错误
      }
      this.client = null;
      this.transport = null;
      throw error;
    }
    this.client = client;
    this.transport = transport;
  }

  async callRaw(
    name: string,
    args: Record<string, unknown>,
    window: Window,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ToolResponseEnvelope> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    signals.push(AbortSignal.timeout(timeoutMs));
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      await this.ensureConnected();
      const result = await this.client!.callTool(
        { name, arguments: args },
        undefined,
        { timeout: timeoutMs, signal },
      );
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.find((item) => item.type === 'text')?.text;
      if (!text) {
        return errorEnvelope(
          'SCHEMA_MISMATCH',
          'MCP 返回没有文本内容',
          false,
          window,
          this.options.dataMode,
        );
      }
      const parsed = ToolResponseEnvelopeSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        const message = parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
        return errorEnvelope(
          'SCHEMA_MISMATCH',
          `MCP 返回不符合协议：${message}`,
          false,
          window,
          this.options.dataMode,
        );
      }
      const envelope = parsed.data as ToolResponseEnvelope;
      if (result.isError && envelope.status !== 'error') {
        return errorEnvelope(
          'SOURCE_UNAVAILABLE',
          'MCP 将调用标记为错误但返回体不是 error 状态',
          true,
          window,
          this.options.dataMode,
        );
      }
      return envelope;
    } catch (error) {
      if (options.signal?.aborted) {
        return errorEnvelope(
          'CANCELLED',
          '调用已取消',
          false,
          window,
          this.options.dataMode,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      const timeout = /timeout|aborted|AbortError/i.test(message);
      await this.reset();
      return errorEnvelope(
        timeout ? 'TIMEOUT' : 'SOURCE_UNAVAILABLE',
        timeout
          ? `MCP 调用超时（${timeoutMs}ms）`
          : `MCP 调用失败：${message}${this.stderrTail ? ` | ${this.stderrTail.slice(-500)}` : ''}`,
        true,
        window,
      );
    }
  }

  async callWithRetry(
    name: string,
    args: Record<string, unknown>,
    window: Window,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      maxAttempts?: number;
      /** 在每次真正发出请求前调用，用于先落库 inflight 日志。 */
      onAttemptStart?: (attempt: number) => void;
      onAttempt?: (attempt: CallAttempt) => void;
    } = {},
  ): Promise<{ envelope: ToolResponseEnvelope; attempts: number }> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    let last: ToolResponseEnvelope | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) {
        return {
          envelope: errorEnvelope(
            'CANCELLED',
            '调用已取消',
            false,
            window,
            this.options.dataMode,
          ),
          attempts: attempt,
        };
      }
      options.onAttemptStart?.(attempt);
      const started = Date.now();
      const envelope = await this.callRaw(name, args, window, options);
      last = envelope;
      options.onAttempt?.({
        attempt,
        envelope,
        durationMs: Date.now() - started,
      });
      if (envelope.status !== 'error') return { envelope, attempts: attempt };
      if (!envelope.error?.retryable || attempt >= maxAttempts) {
        return { envelope, attempts: attempt };
      }
      const backoff = Math.min(2000, 250 * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 120);
      try {
        await sleep(backoff + jitter, options.signal);
      } catch {
        return {
          envelope: errorEnvelope(
            'CANCELLED',
            '调用已取消',
            false,
            window,
            this.options.dataMode,
          ),
          attempts: attempt,
        };
      }
    }
    return {
      envelope:
        last ??
        errorEnvelope(
          'SOURCE_UNAVAILABLE',
          '未知 MCP 错误',
          true,
          window,
          this.options.dataMode,
        ),
      attempts: maxAttempts,
    };
  }

  async reset(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // 忽略关闭错误
    }
    this.client = null;
    this.transport = null;
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
