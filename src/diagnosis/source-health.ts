import type { DiagnosisSource } from './contracts/domain.js';
import type { DiagnosisRepository } from './repository.js';

export interface SourceHealthResult {
  ok: boolean;
  code:
    | 'OK'
    | 'ADAPTER_NOT_CONFIGURED'
    | 'SOURCE_EQUIPMENT_MISSING'
    | 'SOURCE_UNAVAILABLE'
    | 'SOURCE_NO_MATCH';
  message: string;
}

const DEFAULT_RESOLVE_ENDPOINT = '/equipment/resolve';

function resolveEndpoint(): string {
  const raw = process.env.DIAGNOSIS_REST_ENDPOINTS?.trim();
  if (!raw) return DEFAULT_RESOLVE_ENDPOINT;
  try {
    const parsed = JSON.parse(raw) as { resolve?: unknown };
    return typeof parsed.resolve === 'string' && parsed.resolve.trim()
      ? parsed.resolve
      : DEFAULT_RESOLVE_ENDPOINT;
  } catch {
    return DEFAULT_RESOLVE_ENDPOINT;
  }
}

/**
 * 真实 REST 来源连通性检查。
 *
 * 只使用已配置的 base URL、Bearer token 与 resolve 模板，不允许模型或请求体
 * 提供任意 URL。成功只代表该来源可以返回设备匹配，不代表已完成企业接入验收。
 */
export async function testLiveSource(input: {
  source: DiagnosisSource;
  equipmentId: string | null;
  timeoutMs?: number;
}): Promise<SourceHealthResult> {
  const baseUrl = process.env.DIAGNOSIS_REST_BASE_URL?.trim();
  if (!baseUrl) {
    return {
      ok: false,
      code: 'ADAPTER_NOT_CONFIGURED',
      message:
        '未配置 DIAGNOSIS_REST_BASE_URL；本版不猜测企业接口地址，也不发送真实控制指令。',
    };
  }
  if (!input.equipmentId) {
    return {
      ok: false,
      code: 'SOURCE_EQUIPMENT_MISSING',
      message: '该来源尚未关联设备台账，无法验证只读查询。',
    };
  }

  const url = new URL(
    resolveEndpoint().replace(/\{(\w+)\}/g, (_, key: string) =>
      encodeURIComponent(key === 'equipment_id' ? input.equipmentId! : ''),
    ),
    baseUrl,
  );
  url.searchParams.set('query', input.equipmentId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(process.env.DIAGNOSIS_REST_TOKEN
          ? { authorization: `Bearer ${process.env.DIAGNOSIS_REST_TOKEN}` }
          : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        code: 'SOURCE_UNAVAILABLE',
        message: `只读来源返回 HTTP ${response.status}；未读取响应体。`,
      };
    }
    const body = (await response.json()) as { matches?: unknown };
    if (!Array.isArray(body.matches) || body.matches.length === 0) {
      return {
        ok: false,
        code: 'SOURCE_NO_MATCH',
        message: '只读来源可访问，但没有返回该设备的匹配记录。',
      };
    }
    return {
      ok: true,
      code: 'OK',
      message: '只读来源连通且返回设备匹配；未执行任何控制动作。',
    };
  } catch (error) {
    return {
      ok: false,
      code: 'SOURCE_UNAVAILABLE',
      message:
        error instanceof Error && error.name === 'AbortError'
          ? '只读来源检查超时。'
          : '只读来源不可访问；请检查地址、证书与网络策略。',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function liveSourcesReady(
  repo: DiagnosisRepository,
  workspaceId: string,
): DiagnosisSource[] {
  return repo
    .listSources(workspaceId)
    .filter(
      (source) => source.data_mode === 'live' && source.status === 'configured',
    );
}
