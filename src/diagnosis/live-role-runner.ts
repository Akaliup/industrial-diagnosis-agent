import type { ModelMode } from './contracts/domain.js';
import { FixtureRoleRunner } from './fixture-role-runner.js';
import {
  parseRoleOutputText,
  RoleRunnerError,
  type RoleCallInput,
  type RoleCallResult,
  type RoleRunner,
} from './role-runner.js';
import { estimateTokens, sleep } from './util.js';

export interface LiveRoleRunnerOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 只允许 http/https，且由服务端配置，模型不能传入。 */
  allowInsecureLocalhost?: boolean;
}

export interface RoleRunnerFactoryOptions {
  live?: Partial<LiveRoleRunnerOptions>;
}

export function liveOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveRoleRunnerOptions | null {
  const baseUrl = env.DIAGNOSIS_LLM_BASE_URL?.trim();
  const apiKey = env.DIAGNOSIS_LLM_API_KEY?.trim();
  const model = env.DIAGNOSIS_LLM_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return null;
  const timeout = Number(env.DIAGNOSIS_LLM_TIMEOUT_MS ?? 60_000);
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
  };
}

function validateEndpoint(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RoleRunnerError(
      'DIAGNOSIS_LLM_BASE_URL 不是合法 URL',
      'UNCONFIGURED',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RoleRunnerError(
      '模型 Endpoint 只允许 http/https',
      'UNCONFIGURED',
    );
  }
  return url;
}

function contentOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item && typeof item === 'object' && 'text' in item
          ? String((item as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
  }
  return null;
}

function modelOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const model = (payload as { model?: unknown }).model;
  return typeof model === 'string' && model.length > 0 ? model : null;
}

function usageOf(payload: unknown): { input: number; output: number } | null {
  if (!payload || typeof payload !== 'object') return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = Number((usage as { prompt_tokens?: unknown }).prompt_tokens);
  const output = Number(
    (usage as { completion_tokens?: unknown }).completion_tokens,
  );
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output };
}

export class LiveRoleRunner implements RoleRunner {
  readonly mode: ModelMode = 'live';
  readonly model: string;
  private readonly endpoint: string;

  constructor(private readonly options: LiveRoleRunnerOptions) {
    const url = validateEndpoint(options.baseUrl);
    const base = url.toString().replace(/\/+$/, '');
    this.endpoint = base.endsWith('/chat/completions')
      ? base
      : `${base}/chat/completions`;
    this.model = options.model;
  }

  private async post(
    body: unknown,
    signal: AbortSignal,
  ): Promise<{ payload: unknown; status: number; text: string }> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    let text = '';
    let payload: unknown = null;
    try {
      text = await response.text();
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    return { payload, status: response.status, text };
  }

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    const started = Date.now();
    const repair =
      input.repairIssues && input.repairIssues.length > 0
        ? `\n\n上一次输出存在以下问题，必须逐项修复：\n- ${input.repairIssues.join('\n- ')}`
        : '';
    const body = {
      model: this.options.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      // 让模型端也看到剩余输出预算；不依赖模型自行遵守。
      ...(input.limits
        ? { max_tokens: Math.max(1, input.limits.maxOutputTokens) }
        : {}),
      messages: [
        { role: 'system', content: input.context.system },
        { role: 'user', content: `${input.context.user}${repair}` },
      ],
    };
    const remainingDeadline = input.limits
      ? input.limits.deadlineAt - Date.now()
      : this.options.timeoutMs;
    const timeoutMs = Math.max(
      1,
      Math.min(this.options.timeoutMs, remainingDeadline),
    );
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (input.signal) signals.push(input.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    let lastError: RoleRunnerError | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (input.signal?.aborted) {
        throw new RoleRunnerError('模型调用已取消', 'CANCELLED');
      }
      if (attempt > 1) {
        // 重试也是一次真实模型请求，必须先由调用方在 Run 账本中预留。
        input.limits?.onRequest?.();
      }
      try {
        const { payload, status, text } = await this.post(body, signal);
        if (status === 401 || status === 403) {
          throw new RoleRunnerError(
            `模型鉴权失败（HTTP ${status}），请检查 DIAGNOSIS_LLM_API_KEY`,
            'MODEL_ERROR',
            false,
          );
        }
        if (status === 429 || status >= 500) {
          lastError = new RoleRunnerError(
            `模型服务暂时不可用（HTTP ${status}）`,
            'MODEL_ERROR',
            true,
          );
          if (attempt < 3) {
            await sleep(800, input.signal);
            continue;
          }
          throw lastError;
        }
        if (status < 200 || status >= 300) {
          throw new RoleRunnerError(
            `模型调用失败（HTTP ${status}）`,
            'MODEL_ERROR',
            false,
          );
        }
        const raw = contentOf(payload);
        if (!raw) {
          const error = new RoleRunnerError(
            '模型响应没有 choices[0].message.content',
            'MODEL_ERROR',
            true,
          );
          error.usage = {
            inputTokens: estimateTokens(
              `${input.context.system}\n${input.context.user}`,
            ),
            outputTokens: 0,
          };
          error.attempts = attempt;
          error.rawOutput = JSON.stringify({
            status,
            body: text.slice(0, 7_000),
          });
          throw error;
        }
        const usage = usageOf(payload) ?? {
          input: estimateTokens(
            `${input.context.system}\n${input.context.user}`,
          ),
          output: estimateTokens(raw),
        };
        let output: unknown;
        try {
          output = parseRoleOutputText(input.role, raw);
        } catch (error) {
          if (error instanceof RoleRunnerError) {
            error.usage = {
              inputTokens: usage.input,
              outputTokens: usage.output,
            };
            error.attempts = attempt;
            error.rawOutput = raw;
          }
          throw error;
        }
        return {
          output,
          mode: this.mode,
          model: modelOf(payload) ?? this.options.model,
          inputTokens: usage.input,
          outputTokens: usage.output,
          latencyMs: Date.now() - started,
          raw,
          attempts: attempt,
        };
      } catch (error) {
        if (error && (error as { code?: string }).code === 'BUDGET_EXCEEDED') {
          throw error;
        }
        if (error instanceof RoleRunnerError) {
          if (error.attempts === undefined) error.attempts = attempt;
          if (!error.usage) {
            error.usage = {
              inputTokens: estimateTokens(
                `${input.context.system}\n${input.context.user}`,
              ),
              outputTokens: 0,
            };
          }
          if (!error.retryable || attempt >= 3) throw error;
          lastError = error;
        } else if (input.signal?.aborted) {
          throw new RoleRunnerError('模型调用已取消', 'CANCELLED');
        } else {
          const message =
            error instanceof Error ? error.message : String(error);
          lastError = new RoleRunnerError(
            `模型调用异常：${message}`,
            'MODEL_ERROR',
            true,
          );
          lastError.usage = {
            inputTokens: estimateTokens(
              `${input.context.system}\n${input.context.user}`,
            ),
            outputTokens: 0,
          };
          lastError.attempts = attempt;
          if (attempt >= 3) throw lastError;
        }
        await sleep(800, input.signal);
      }
    }
    throw (
      lastError ?? new RoleRunnerError('模型调用失败', 'MODEL_ERROR', false)
    );
  }
}

export function createRoleRunner(
  mode: ModelMode,
  options: RoleRunnerFactoryOptions = {},
): RoleRunner {
  if (mode === 'fixture') {
    return new FixtureRoleRunner();
  }
  const env = liveOptionsFromEnv();
  const merged: LiveRoleRunnerOptions | null = env
    ? { ...env, ...options.live }
    : options.live &&
        options.live.baseUrl &&
        options.live.apiKey &&
        options.live.model
      ? {
          baseUrl: options.live.baseUrl,
          apiKey: options.live.apiKey,
          model: options.live.model,
          timeoutMs: options.live.timeoutMs ?? 60_000,
        }
      : null;
  if (!merged) {
    throw new RoleRunnerError(
      '未配置真实模型：需要 DIAGNOSIS_LLM_BASE_URL、DIAGNOSIS_LLM_API_KEY、DIAGNOSIS_LLM_MODEL。Live 模式不会回退到 Fixture。',
      'UNCONFIGURED',
    );
  }
  return new LiveRoleRunner(merged);
}
