import type {
  Approval,
  ControlReceiptStatus,
  RiskLevel,
} from './contracts/domain.js';

export const CONTROL_EXECUTION = 'disabled' as const;

export function isHighRisk(risk: RiskLevel): boolean {
  return risk === 'control' || risk === 'control_intent';
}

/**
 * 高风险控制建议不能由申请人自己批准。
 * 只读/知识类建议不涉及设备动作，可以由同一人确认。
 */
export function selfApprovalForbidden(
  approval: Pick<Approval, 'requested_by' | 'risk_level'>,
  userId: string,
): boolean {
  return approval.requested_by === userId && isHighRisk(approval.risk_level);
}

export function approvalExpired(
  approval: Pick<Approval, 'expires_at'>,
  now = Date.now(),
): boolean {
  const expires = Date.parse(approval.expires_at);
  return !Number.isFinite(expires) || expires < now;
}

export type ReceiptDisposition =
  | 'not_executed'
  | 'unconfirmed'
  | 'failed'
  | 'no_receipt';

/**
 * 回执只描述外部执行器的回执状态，不代表诊断服务执行了控制。
 * 本版本没有控制执行器，因此任何回执都只能作为“未执行/未确认”处理。
 */
export function receiptDisposition(
  status: ControlReceiptStatus | null,
): ReceiptDisposition {
  if (!status) return 'no_receipt';
  if (status === 'unknown') return 'unconfirmed';
  if (status === 'failed') return 'failed';
  return 'not_executed';
}
