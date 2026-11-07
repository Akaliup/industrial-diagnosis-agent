import type { DiagnosisOrchestrator } from './orchestrator.js';
import type { DiagnosisRepository } from './repository.js';
import { nowIso } from './util.js';

export interface DiagnosisWorkerOptions {
  repo: DiagnosisRepository;
  orchestrator: DiagnosisOrchestrator;
  /** 并发执行的 Run 数，默认 2；诊断 Run 含模型与 MCP 子进程，不宜过大。 */
  concurrency?: number;
  /** 空闲轮询间隔，默认 500ms。 */
  pollIntervalMs?: number;
  /** 租约时长，默认 30s；orchestrator 会在每次阶段检查时续租。 */
  leaseMs?: number;
  onError?: (runId: string, error: unknown) => void;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

/**
 * 诊断 Run 的本地执行 Worker。
 *
 * - 使用数据库租约 + CAS claim，多个进程/实例不会重复推进同一 Run。
 * - 启动时接管过期租约的 running Run（崩溃恢复），orchestrator 从 checkpoint 续跑。
 * - 取消通过 AbortSignal 传播到模型、MCP 与网络；数据库中的 cancelled 状态
 *   由 orchestrator 的 cancel() 写入。
 */
export class DiagnosisWorker {
  private readonly repo: DiagnosisRepository;
  private readonly orchestrator: DiagnosisOrchestrator;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly onError?: (runId: string, error: unknown) => void;
  private readonly owner: string;
  private readonly active = new Map<string, ActiveRun>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = true;

  constructor(options: DiagnosisWorkerOptions) {
    this.repo = options.repo;
    this.orchestrator = options.orchestrator;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 500);
    this.leaseMs = Math.max(5_000, options.leaseMs ?? 30_000);
    this.onError = options.onError;
    this.owner = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get ownerId(): string {
    return this.owner;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // 不等待第一次 tick：启动后立即恢复遗留 Run。
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((item) => item.promise),
    );
  }

  /** 新建 Run 后立即唤醒，避免等待轮询。 */
  kick(): void {
    if (this.stopped) return;
    void this.tick();
  }

  /** 取消一个正在本 Worker 执行的 Run；返回是否找到了活动执行。 */
  cancel(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.recoverExpired();
      const available = this.concurrency - this.active.size;
      if (available <= 0) return;
      const queued = this.repo.findQueuedRuns(available * 2);
      for (const run of queued) {
        if (this.active.size >= this.concurrency) break;
        if (this.active.has(run.id)) continue;
        if (!this.repo.claimRun(run.id, this.owner, this.leaseMs)) continue;
        this.launch(run.id);
      }
    } catch (error) {
      this.onError?.('*', error);
    } finally {
      this.ticking = false;
    }
  }

  private async recoverExpired(): Promise<void> {
    const expired = this.repo.findExpiredRunningRuns(nowIso());
    for (const run of expired) {
      if (this.active.has(run.id)) continue;
      if (this.active.size >= this.concurrency) break;
      // claimRun 的 WHERE 条件允许接管过期租约；失败说明其他实例先接管了。
      if (!this.repo.claimRun(run.id, this.owner, this.leaseMs)) continue;
      this.launch(run.id);
    }
  }

  private launch(runId: string): void {
    const controller = new AbortController();
    const promise = this.orchestrator
      .execute(runId, { owner: this.owner, signal: controller.signal })
      .then(() => undefined)
      .catch((error) => {
        this.onError?.(runId, error);
      })
      .finally(() => {
        this.active.delete(runId);
      });
    this.active.set(runId, { controller, promise });
  }
}
