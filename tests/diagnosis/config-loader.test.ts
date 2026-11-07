import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  loadDiagnosisEnv,
  validateDiagnosisEnv,
} from '../../src/diagnosis/load-env.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnosis-env-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('diagnosis config loader', () => {
  test('loads .env.diagnosis without overriding shell variables', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, '.env.diagnosis'),
      [
        'DIAGNOSIS_PORT=3211',
        'DIAGNOSIS_DATA_MODE=mock',
        'DIAGNOSIS_MODEL_MODE=fixture',
        'DIAGNOSIS_REST_MAPPING={"fields":{"state":"data.status"}}',
      ].join('\n'),
    );
    const env: NodeJS.ProcessEnv = { DIAGNOSIS_PORT: '3999' };
    const result = loadDiagnosisEnv(env, dir);
    expect(result.file).toBe(path.join(dir, '.env.diagnosis'));
    expect(env.DIAGNOSIS_PORT).toBe('3999');
    expect(env.DIAGNOSIS_DATA_MODE).toBe('mock');
    expect(env.DIAGNOSIS_MODEL_MODE).toBe('fixture');
    expect(result.keys).toContain('DIAGNOSIS_DATA_MODE');
  });

  test('works without a config file', () => {
    const dir = tempDir();
    const env: NodeJS.ProcessEnv = {};
    const result = loadDiagnosisEnv(env, dir);
    expect(result.file).toBeNull();
    expect(result.keys).toEqual([]);
  });

  test('fails clearly on invalid values', () => {
    expect(() =>
      validateDiagnosisEnv({ DIAGNOSIS_PORT: 'not-a-port' }),
    ).toThrow(/DIAGNOSIS_PORT/);
    expect(() => validateDiagnosisEnv({ DIAGNOSIS_DATA_MODE: 'prod' })).toThrow(
      /DIAGNOSIS_DATA_MODE/,
    );
    expect(() =>
      validateDiagnosisEnv({
        DIAGNOSIS_MODEL_MODE: 'live',
        DIAGNOSIS_LLM_BASE_URL: 'https://example.invalid/v1',
      }),
    ).toThrow(/DIAGNOSIS_LLM_API_KEY/);
    expect(() =>
      validateDiagnosisEnv({ DIAGNOSIS_WEBHOOK_SECRETS: 'not-json' }),
    ).toThrow(/DIAGNOSIS_WEBHOOK_SECRETS/);
  });

  test('accepts inline and file mappings but rejects missing files', () => {
    const dir = tempDir();
    expect(() =>
      validateDiagnosisEnv({ DIAGNOSIS_REST_MAPPING: '{"fields":{}}' }),
    ).not.toThrow();
    expect(() =>
      validateDiagnosisEnv({
        DIAGNOSIS_REST_MAPPING: path.join(dir, 'missing.json'),
      }),
    ).toThrow(/文件不存在/);
  });

  test('debug logging lists loaded keys but never values', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, '.env.diagnosis'),
      'DIAGNOSIS_PORT=3222\nDIAGNOSIS_LLM_API_KEY=super-secret-value\n',
    );
    const env: NodeJS.ProcessEnv = { DIAGNOSIS_ENV_DEBUG: '1' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      loadDiagnosisEnv(env, dir);
      const logged = spy.mock.calls
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(logged).toContain('DIAGNOSIS_LLM_API_KEY');
      expect(logged).not.toContain('super-secret-value');
    } finally {
      spy.mockRestore();
    }
  });

  test('DIAGNOSIS_ENV_FILE overrides the default path', () => {
    const dir = tempDir();
    const file = path.join(dir, 'custom.env');
    fs.writeFileSync(file, 'DIAGNOSIS_PORT=3222\n');
    const env: NodeJS.ProcessEnv = { DIAGNOSIS_ENV_FILE: file };
    const result = loadDiagnosisEnv(env, dir);
    expect(result.file).toBe(file);
    expect(env.DIAGNOSIS_PORT).toBe('3222');
  });
});
