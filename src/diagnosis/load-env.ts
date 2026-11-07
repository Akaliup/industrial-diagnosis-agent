/**
 * 设备智诊统一配置入口。
 *
 * 服务、setup、Eval 和 smoke 脚本都必须先加载本模块，再读取 process.env。
 * 优先级：shell 环境变量 > `.env.diagnosis` > 代码默认值。
 * 文件不存在时静默使用默认值；格式/取值错误时明确失败，避免“看起来已配置但没生效”。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export interface DiagnosisEnvLoadResult {
  file: string | null;
  keys: string[];
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
): void {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}..${max} 的整数，收到 ${raw}`);
  }
}

function jsonObject(env: NodeJS.ProcessEnv, name: string): void {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('必须是 JSON 对象');
    }
  } catch (error) {
    throw new Error(
      `${name} 不是合法 JSON 对象：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function validateDiagnosisEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  positiveInt(env, 'DIAGNOSIS_PORT', 1, 65535);
  positiveInt(env, 'DIAGNOSIS_LEASE_MS', 1_000, 3_600_000);
  positiveInt(env, 'DIAGNOSIS_LLM_TIMEOUT_MS', 1, 3_600_000);
  positiveInt(env, 'DIAGNOSIS_REST_TIMEOUT_MS', 1, 3_600_000);

  const dataMode = env.DIAGNOSIS_DATA_MODE?.trim();
  if (dataMode && !['mock', 'replay', 'live'].includes(dataMode)) {
    throw new Error(
      `DIAGNOSIS_DATA_MODE 必须是 mock/replay/live，收到 ${dataMode}`,
    );
  }
  const modelMode = env.DIAGNOSIS_MODEL_MODE?.trim();
  if (modelMode && !['fixture', 'live'].includes(modelMode)) {
    throw new Error(
      `DIAGNOSIS_MODEL_MODE 必须是 fixture/live，收到 ${modelMode}`,
    );
  }
  jsonObject(env, 'DIAGNOSIS_REST_ENDPOINTS');
  jsonObject(env, 'DIAGNOSIS_WEBHOOK_SECRETS');

  const mapping = env.DIAGNOSIS_REST_MAPPING?.trim();
  if (mapping && !mapping.startsWith('{')) {
    if (!fs.existsSync(path.resolve(mapping))) {
      throw new Error(`DIAGNOSIS_REST_MAPPING 文件不存在：${mapping}`);
    }
  } else if (mapping) {
    try {
      JSON.parse(mapping);
    } catch (error) {
      throw new Error(
        `DIAGNOSIS_REST_MAPPING 不是合法 JSON：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const baseUrl = env.DIAGNOSIS_LLM_BASE_URL?.trim();
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('只允许 http/https');
      }
    } catch (error) {
      throw new Error(
        `DIAGNOSIS_LLM_BASE_URL 不合法：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (modelMode === 'live') {
    const missing = [
      'DIAGNOSIS_LLM_BASE_URL',
      'DIAGNOSIS_LLM_API_KEY',
      'DIAGNOSIS_LLM_MODEL',
    ].filter((name) => !env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(
        `DIAGNOSIS_MODEL_MODE=live 但缺少 ${missing.join(', ')}；不会回退 Fixture`,
      );
    }
  }
}

/**
 * 加载 `.env.diagnosis`（可用 DIAGNOSIS_ENV_FILE 覆盖路径）。
 * 只填充尚未存在的变量，保证 shell 环境变量优先。
 */
export function loadDiagnosisEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): DiagnosisEnvLoadResult {
  const configured = env.DIAGNOSIS_ENV_FILE?.trim();
  const file = configured
    ? path.resolve(cwd, configured)
    : path.resolve(cwd, '.env.diagnosis');
  if (!fs.existsSync(file)) {
    validateDiagnosisEnv(env);
    return { file: null, keys: [] };
  }
  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  const keys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      keys.push(key);
    }
  }
  validateDiagnosisEnv(env);
  if (env.DIAGNOSIS_ENV_DEBUG === '1') {
    // 只打印键名和文件路径，不打印值，避免密钥进入日志。
    console.error(
      `[diagnosis] loaded ${keys.length} keys from ${file}: ${keys.join(', ')}`,
    );
  }
  return { file, keys };
}

// 作为入口模块的第一个 import 时立即生效。
loadDiagnosisEnv();
