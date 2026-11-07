import type { ToolResponseEnvelope } from './contracts/domain.js';
import { canonicalJson, sha256 } from './util.js';

export interface RepeatCheck {
  action: 'execute' | 'cached' | 'rejected';
  cached?: ToolResponseEnvelope;
  message?: string;
}

/**
 * 重复调用守卫。
 *
 * key = 工具 + 规范化业务参数 + Run/Workspace 作用域 + 来源快照版本。
 * 成功响应复用缓存；连续第 2 次相同请求起拒绝，并提示已有证据。
 * 传输层重试不经过这里，因此不会与“同参数重试”冲突。
 */
export class RepeatGuard {
  private readonly cache = new Map<string, ToolResponseEnvelope>();
  private lastKey: string | null = null;
  private consecutive = 0;

  key(
    tool: string,
    args: unknown,
    scope: string,
    sourceVersion: string,
  ): string {
    return sha256(`${tool}|${canonicalJson(args)}|${scope}|${sourceVersion}`);
  }

  check(key: string): RepeatCheck {
    if (key === this.lastKey) {
      this.consecutive += 1;
      if (this.consecutive >= 2) {
        return {
          action: 'rejected',
          message:
            '相同参数的查询已连续请求，已有证据可直接引用；请改变窗口或指标',
        };
      }
    } else {
      this.lastKey = key;
      this.consecutive = 1;
    }
    const cached = this.cache.get(key);
    if (cached) return { action: 'cached', cached };
    return { action: 'execute' };
  }

  record(key: string, envelope: ToolResponseEnvelope): void {
    if (
      envelope.status === 'success' ||
      envelope.status === 'partial' ||
      envelope.status === 'no_data'
    ) {
      this.cache.set(key, envelope);
    }
  }

  /** 取消/未执行的请求不构成“连续重复”，也不应留下可复用结果。 */
  forget(key: string): void {
    this.cache.delete(key);
    if (this.lastKey === key) {
      this.lastKey = null;
      this.consecutive = 0;
    }
  }

  reset(): void {
    this.cache.clear();
    this.lastKey = null;
    this.consecutive = 0;
  }
}
