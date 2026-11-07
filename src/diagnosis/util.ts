import crypto from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function sha256(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/**
 * 保守 token 估算：中文按 1 token/字，其他按 3.5 字符/token。
 * 没有准确 tokenizer 时用于预算与 ContextManifest，标记 estimated。
 */
export function estimateTokens(text: string): number {
  let chinese = 0;
  let other = 0;
  for (const char of text) {
    if (/[㐀-鿿]/.test(char)) chinese += 1;
    else other += 1;
  }
  return Math.ceil(chinese + other / 3.5);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}
