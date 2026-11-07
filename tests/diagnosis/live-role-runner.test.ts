import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveRoleRunner } from '../../src/diagnosis/live-role-runner.js';
import {
  RoleRunnerError,
  type RoleCallInput,
} from '../../src/diagnosis/role-runner.js';

function response(status: number, body: string): Response {
  return {
    status,
    text: async () => body,
  } as Response;
}

function successBody(content: string, model = 'deepseek-flash'): string {
  return JSON.stringify({
    model,
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

const validContent = '{"summary":"ok","queries":[]}';

function makeInput(): RoleCallInput {
  return {
    role: 'data_investigator',
    stage: 'confirm_status',
    context: { system: 'system prompt', user: 'user prompt' },
  } as unknown as RoleCallInput;
}

function makeRunner(): LiveRoleRunner {
  return new LiveRoleRunner({
    baseUrl: 'https://llm.example.test/v1',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    timeoutMs: 5_000,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LiveRoleRunner error handling', () => {
  it('retries 429 and records the provider-returned model', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, '{"error":"busy"}'))
      .mockResolvedValueOnce(response(200, successBody(validContent)));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeRunner().run(makeInput());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.model).toBe('deepseek-flash');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it('stops after three 5xx attempts', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => response(503, '{"error":"down"}'));
    vi.stubGlobal('fetch', fetchMock);

    const error = await makeRunner()
      .run(makeInput())
      .catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(RoleRunnerError);
    expect((error as RoleRunnerError).code).toBe('MODEL_ERROR');
    expect((error as RoleRunnerError).attempts).toBe(3);
  });

  it('does not retry authentication failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401, '{"error":"unauthorized"}'));
    vi.stubGlobal('fetch', fetchMock);

    const error = await makeRunner()
      .run(makeInput())
      .catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((error as RoleRunnerError).code).toBe('MODEL_ERROR');
    expect((error as RoleRunnerError).retryable).toBe(false);
  });

  it('retries empty 200 responses and keeps the raw body', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => response(200, '{"choices":[]}'));
    vi.stubGlobal('fetch', fetchMock);

    const error = await makeRunner()
      .run(makeInput())
      .catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((error as RoleRunnerError).code).toBe('MODEL_ERROR');
    expect((error as RoleRunnerError).attempts).toBe(3);
    expect((error as RoleRunnerError).rawOutput).toContain('"status":200');
  });

  it('rejects invalid JSON without a blind retry', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => response(200, successBody('not json')));
    vi.stubGlobal('fetch', fetchMock);

    const error = await makeRunner()
      .run(makeInput())
      .catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((error as RoleRunnerError).code).toBe('INVALID_OUTPUT');
    expect((error as RoleRunnerError).retryable).toBe(false);
    expect((error as RoleRunnerError).rawOutput).toBe('not json');
  });

  it('sends the configured max output tokens', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, successBody(validContent)));
    vi.stubGlobal('fetch', fetchMock);

    await makeRunner().run({
      ...makeInput(),
      limits: {
        maxOutputTokens: 4500,
        deadlineAt: Date.now() + 30_000,
      },
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { max_tokens?: number };
    expect(body.max_tokens).toBe(4500);
  });
});
