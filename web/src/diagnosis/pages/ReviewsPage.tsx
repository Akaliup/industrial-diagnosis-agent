import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  Check,
  ClipboardCheck,
  Loader2,
  Lock,
  ShieldAlert,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { diagnosisApi, type EquipmentView } from '../api';
import type { Approval } from '../contracts.generated';
import { useWorkspace } from '../workspace';
import { useAsync } from '../hooks/useAsync';
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  StatusBadge,
  formatTime,
  riskLabel,
} from '../components/common';

const APPROVAL_STATUS: Record<string, { label: string; className: string }> = {
  pending: {
    label: '待审批',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  approved: {
    label: '已批准',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  rejected: {
    label: '已驳回',
    className: 'border-red-200 bg-red-50 text-red-700',
  },
  expired: {
    label: '已过期',
    className: 'border-gray-200 bg-gray-50 text-gray-500',
  },
  invalidated: {
    label: '已失效',
    className: 'border-gray-200 bg-gray-50 text-gray-500',
  },
};

export function ReviewsPage() {
  const { workspaceId } = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const {
    data,
    loading,
    error: loadError,
    reload,
  } = useAsync(async () => {
    const [runResult, approvalResult, equipmentResult] = await Promise.all([
      diagnosisApi.runs({
        workspace_id: workspaceId,
        status: 'awaiting_human',
      }),
      diagnosisApi.approvals({ workspace_id: workspaceId }),
      diagnosisApi.equipment(workspaceId),
    ]);
    return {
      // 复核结论写回 review_status；已复核的任务不再占用待复核列表。
      runs: runResult.runs.filter((run) => run.review_status === 'pending'),
      approvals: approvalResult.approvals,
      equipment: equipmentResult.equipment,
    };
  }, [workspaceId]);

  const equipmentById = new Map<string, EquipmentView>(
    (data?.equipment ?? []).map((item) => [item.equipment_id, item]),
  );

  const handleDecision = async (
    approval: Approval,
    decision: 'approved' | 'rejected',
  ) => {
    setBusy(approval.id);
    setError(null);
    setNotice(null);
    try {
      const result = await diagnosisApi.decideApproval(
        approval.id,
        decision,
        workspaceId,
      );
      setNotice(result.message);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '审批失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="diag-fade-up">
      <PageHeader
        title="复核与审批"
        description="人工复核写回报告结论；控制建议只登记审批意图，本版本不会执行真实设备控制。"
        actions={
          <Button variant="outline" size="sm" onClick={reload}>
            刷新
          </Button>
        }
      />

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        <span>
          控制执行始终为
          disabled。审批通过只代表允许工程师按规程现场处理，不会向设备下发任何指令；高风险建议不能由申请人自己批准。
        </span>
      </div>

      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 diag-fade-in">
          <Check className="mt-0.5 size-3.5 shrink-0" />
          {notice}
        </div>
      ) : null}

      {loading && !data ? (
        <LoadingBlock rows={4} />
      ) : loadError ? (
        <ErrorState error={loadError} onRetry={reload} />
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          <div>
            <SectionTitle
              title="待复核诊断"
              hint="点击进入工作台，查看证据、提交接受或驳回。"
            />
            <div className="space-y-2">
              {(data?.runs ?? []).map((run) => (
                <Link key={run.id} to={`/runs/${run.id}`}>
                  <Card className="diag-card diag-card-hover p-3.5">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={run.status} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-900">
                        {equipmentById.get(run.equipment_id)?.name ??
                          run.equipment_id}
                      </span>
                      <ArrowUpRight className="size-3.5 text-gray-300" />
                    </div>
                    <div className="mt-1.5 line-clamp-1 text-[11px] text-gray-500">
                      {run.symptom ?? '未填写症状'}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-400">
                      <span>{formatTime(run.created_at)}</span>
                      <span>{run.total_rounds} 轮</span>
                      <span>{run.logical_calls} 次工具</span>
                      {run.handoff_reason ? (
                        <span className="text-amber-700">转人工</span>
                      ) : null}
                    </div>
                  </Card>
                </Link>
              ))}
              {(data?.runs.length ?? 0) === 0 ? (
                <EmptyState
                  icon={<ClipboardCheck className="size-5" />}
                  title="没有待复核的诊断"
                  description="完成诊断且需要人工判断的任务会出现在这里。"
                />
              ) : null}
            </div>
          </div>

          <div>
            <SectionTitle
              title="控制建议审批"
              hint="仅登记建议意图；receipt 状态不代表设备已执行。"
            />
            <div className="space-y-2">
              {(data?.approvals ?? []).map((approval) => {
                const config =
                  APPROVAL_STATUS[approval.status] ?? APPROVAL_STATUS.expired;
                return (
                  <Card key={approval.id} className="diag-card p-3.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="diag-code min-w-0 flex-1 truncate text-[11px] text-gray-700">
                        {approval.action_id}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[10px]',
                          config.className,
                        )}
                      >
                        {config.label}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-400">
                      <Link
                        to={`/runs/${approval.run_id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {approval.run_id}
                      </Link>
                      <span>{approval.equipment_id}</span>
                      <span>风险 {riskLabel(approval.risk_level)}</span>
                      <span>到期 {formatTime(approval.expires_at)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-[10px] text-gray-400">
                      <span className="diag-code">
                        {approval.params_hash.slice(0, 16)}…
                      </span>
                      <span className="ml-auto">
                        {approval.receipt_status
                          ? `回执 ${approval.receipt_status}`
                          : '无回执（不执行）'}
                      </span>
                    </div>
                    {approval.status === 'pending' ? (
                      <div className="mt-2 flex justify-end gap-1.5 border-t border-gray-100 pt-2">
                        <Button
                          variant="outline"
                          size="xs"
                          className="border-red-200 text-red-700 hover:bg-red-50"
                          onClick={() => handleDecision(approval, 'rejected')}
                          disabled={busy === approval.id}
                        >
                          {busy === approval.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <X className="size-3" />
                          )}
                          驳回
                        </Button>
                        <Button
                          size="xs"
                          className="bg-blue-600 text-white hover:bg-blue-700"
                          onClick={() => handleDecision(approval, 'approved')}
                          disabled={busy === approval.id}
                        >
                          {busy === approval.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Check className="size-3" />
                          )}
                          批准建议
                        </Button>
                      </div>
                    ) : null}
                  </Card>
                );
              })}
              {(data?.approvals.length ?? 0) === 0 ? (
                <EmptyState
                  icon={<Lock className="size-5" />}
                  title="没有审批建议"
                  description="在等待复核的诊断工作台中，可以为需要人工确认的建议登记审批。"
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
