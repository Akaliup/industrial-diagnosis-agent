/**
 * 诊断运行期的控制流错误。
 *
 * 放在独立模块中，避免 ToolGateway 为了识别租约丢失而反向依赖 Orchestrator。
 */
export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class RunCancelledError extends Error {
  readonly code = 'CANCELLED';
  constructor() {
    super('Run 已取消');
    this.name = 'RunCancelledError';
  }
}

export class LeaseLostError extends Error {
  readonly code = 'LEASE_LOST';
  constructor() {
    super('Run 租约已失效，另一个 Worker 已接管');
    this.name = 'LeaseLostError';
  }
}

export class AlreadyFinishedError extends Error {
  readonly code = 'ALREADY_FINISHED';
  constructor() {
    super('Run 已结束');
    this.name = 'AlreadyFinishedError';
  }
}
