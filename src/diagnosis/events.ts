import type { RunEvent } from './contracts/domain.js';

export type RunEventListener = (event: RunEvent) => void;

export class DiagnosisEventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  subscribe(runId: string, listener: RunEventListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(runId);
    };
  }

  publish(event: RunEvent): void {
    const set = this.listeners.get(event.run_id);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // 单个订阅者失败不能阻断其它订阅者或持久化
      }
    }
  }
}
