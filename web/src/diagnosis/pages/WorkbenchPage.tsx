import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Download,
  FileText,
  Gauge,
  History,
  Info,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { diagnosisApi, type RunDetail, type RunView } from '../api';
import type { Approval, Evidence, RunEvent } from '../contracts.generated';
import { useWorkspace } from '../workspace';
import { useAsync } from '../hooks/useAsync';
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  ModeBadge,
  PageHeader,
  SectionTitle,
  StatusBadge,
  duration,
  formatTime,
  riskLabel,
  rootCauseLabel,
  runDisplayStatus,
  stageLabel,
  statusLabel,
} from '../components/common';
import { StageTimeline } from '../components/StageTimeline';
import { TelemetryChart } from '../components/TelemetryChart';
import { ToolTrace } from '../components/ToolTrace';
import { EvidenceDrawer } from '../components/EvidenceDrawer';

const EVENT_LABELS: Record<string, string> = {
  'run.created': '创建任务',
  'run.started': '开始诊断',
  'stage.changed': '阶段切换',
  'tool.started': '工具开始',
  'tool.finished': '工具完成',
  'evidence.added': '证据入库',
  'hypothesis.updated': '假设更新',
  'review.required': '等待复核',
  'report.ready': '报告生成',
  'run.failed': '诊断失败',
  'run.cancelled': '任务取消',
  'run.awaiting_human': '转人工',
};

const HYPOTHESIS_STATUS: Record<string, { label: string; className: string }> =
  {
    supported: {
      label: '已支持',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    },
    contradicted: {
      label: '已排除',
      className: 'border-red-200 bg-red-50 text-red-700',
    },
    inconclusive: {
      label: '不确定',
      className: 'border-amber-200 bg-amber-50 text-amber-700',
    },
    proposed: {
      label: '待验证',
      className: 'border-gray-200 bg-gray-50 text-gray-600',
    },
  };

function HypothesisStatusBadge({ status }: { status: string }) {
  const config = HYPOTHESIS_STATUS[status] ?? HYPOTHESIS_STATUS.proposed;
  return (
    <Badge
      variant="outline"
      className={cn('rounded-full px-2 py-0.5 text-[10px]', config.className)}
    >
      {config.label}
    </Badge>
  );
}

function UsageBar({
  label,
  used,
  max,
}: {
  label: string;
  used: number;
  max: number;
}) {
  const percent = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-gray-400">{label}</span>
        <span className="font-medium text-gray-600">
          {used}/{max}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-gray-100">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            percent >= 90
              ? 'bg-red-500'
              : percent >= 70
                ? 'bg-amber-500'
                : 'bg-blue-500',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function EvidenceChip({
  id,
  evidence,
  tone = 'default',
  onOpen,
}: {
  id: string;
  evidence: Evidence | undefined;
  tone?: 'default' | 'contradict';
  onOpen: (evidence: Evidence) => void;
}) {
  const kind = evidence?.payload.kind;
  return (
    <button
      type="button"
      disabled={!evidence}
      onClick={() => evidence && onOpen(evidence)}
      title={evidence ? `${kind} · ${id}` : `证据 ${id} 不在当前 Run 中`}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors',
        tone === 'contradict'
          ? 'border-red-100 bg-red-50/60 text-red-600 hover:border-red-200'
          : 'border-gray-200 bg-white text-gray-500 hover:border-blue-200 hover:text-blue-700',
        !evidence && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current opacity-60" />
      <span className="diag-code truncate">{id}</span>
    </button>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-[11px]">
      <span className="shrink-0 text-gray-400">{label}</span>
      <span className="min-w-0 text-right break-words text-gray-700">
        {value}
      </span>
    </div>
  );
}

export function WorkbenchPage() {
  const { runId } = useParams<{ runId: string }>();
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();

  const { data, loading, error, reload } = useAsync(async () => {
    const detail = await diagnosisApi.run(runId!, workspaceId);
    let approvals: Approval[] = [];
    try {
      const result = await diagnosisApi.approvals({
        workspace_id: workspaceId,
      });
      approvals = result.approvals.filter((item) => item.run_id === runId);
    } catch {
      approvals = [];
    }
    let equipment: Awaited<
      ReturnType<typeof diagnosisApi.equipmentDetail>
    > | null = null;
    try {
      equipment = await diagnosisApi.equipmentDetail(
        detail.run.equipment_id,
        workspaceId,
      );
    } catch {
      equipment = null;
    }
    return { detail, approvals, equipment };
  }, [runId, workspaceId]);

  const detail: RunDetail | undefined = data?.detail;
  const run: RunView | undefined = detail?.run;

  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  const [wsState, setWsState] = useState<'idle' | 'open' | 'closed'>('idle');
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [reviewDecision, setReviewDecision] = useState<'accepted' | 'rejected'>(
    'accepted',
  );
  const [reviewComment, setReviewComment] = useState('');
  const [reviewObservations, setReviewObservations] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeNote, setResumeNote] = useState('');
  const [resuming, setResuming] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const reloadTimer = useRef<number | null>(null);

  const active = run?.status === 'queued' || run?.status === 'running';

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => reloadRef.current(), 2500);
    return () => window.clearInterval(timer);
  }, [active, runId]);

  const scheduleReload = () => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      reloadRef.current();
      reloadTimer.current = null;
    }, 350);
  };

  useEffect(() => {
    if (!runId || !active) {
      setWsState('idle');
      return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const afterSeq = Math.max(
      0,
      ...(detail?.events ?? []).map((event) => event.seq),
      ...liveEvents.map((event) => event.seq),
    );
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/ws/diagnosis?run_id=${encodeURIComponent(
        runId,
      )}&after_seq=${afterSeq}`,
    );
    socket.onopen = () => setWsState('open');
    socket.onclose = () => setWsState('closed');
    socket.onerror = () => setWsState('closed');
    socket.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data as string) as {
          type?: string;
          event?: RunEvent;
        };
        if (payload.type === 'event' && payload.event) {
          const event = payload.event;
          setLiveEvents((previous) =>
            previous.some((item) => item.event_id === event.event_id)
              ? previous
              : [...previous, event].slice(-500),
          );
          if (
            [
              'stage.changed',
              'report.ready',
              'run.awaiting_human',
              'run.failed',
              'run.cancelled',
              'run.started',
            ].includes(event.type)
          ) {
            scheduleReload();
          }
        }
      } catch {
        /* 忽略非 JSON 帧 */
      }
    };
    return () => {
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, active]);

  const events = useMemo(() => {
    const map = new Map<string, RunEvent>();
    for (const event of detail?.events ?? []) map.set(event.event_id, event);
    for (const event of liveEvents) map.set(event.event_id, event);
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }, [detail?.events, liveEvents]);

  const evidenceById = useMemo(() => {
    const map = new Map<string, Evidence>();
    for (const item of detail?.evidence ?? []) map.set(item.id, item);
    return map;
  }, [detail?.evidence]);

  const hypotheses = useMemo(() => {
    const list = [...(detail?.hypotheses ?? [])];
    const rank: Record<string, number> = {
      supported: 0,
      inconclusive: 1,
      proposed: 2,
      contradicted: 3,
    };
    return list.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  }, [detail?.hypotheses]);

  const primary =
    hypotheses.find((item) => item.status === 'supported') ?? hypotheses[0];

  const openEvidence = (item: Evidence) => {
    setSelectedEvidence(item);
    setDrawerOpen(true);
  };

  const handleCancel = async () => {
    if (!run) return;
    if (!cancelArmed) {
      setCancelArmed(true);
      window.setTimeout(() => setCancelArmed(false), 4000);
      return;
    }
    setCancelling(true);
    setActionError(null);
    try {
      await diagnosisApi.cancelRun(run.id, workspaceId);
      setNotice('任务已取消，已获得的证据会保留。');
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '取消任务失败');
    } finally {
      setCancelling(false);
      setCancelArmed(false);
    }
  };

  const handleReview = async () => {
    if (!run) return;
    setReviewing(true);
    setActionError(null);
    try {
      await diagnosisApi.submitReview(run.id, {
        workspace_id: workspaceId,
        decision: reviewDecision,
        comment: reviewComment,
        observations: reviewObservations
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      });
      setNotice(
        reviewDecision === 'accepted'
          ? '复核已提交：结论被接受。'
          : '复核已提交：结论被驳回，请补充信息后继续诊断。',
      );
      setReviewComment('');
      setReviewObservations('');
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '提交复核失败');
    } finally {
      setReviewing(false);
    }
  };

  const handleResume = async () => {
    if (!run || !resumeNote.trim()) return;
    setResuming(true);
    setActionError(null);
    try {
      const result = await diagnosisApi.resumeRun(
        run.id,
        resumeNote.trim(),
        workspaceId,
      );
      navigate(`/runs/${result.run.id}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '无法继续诊断');
    } finally {
      setResuming(false);
    }
  };

  const handleApproval = async (recommendationId: string, text: string) => {
    if (!run) return;
    setApprovalBusy(recommendationId);
    setActionError(null);
    try {
      const result = await diagnosisApi.createApproval(run.id, {
        workspace_id: workspaceId,
        action_id: `recommendation:${recommendationId}`,
        risk_level: 'control_intent',
        params: { recommendation_id: recommendationId, text },
      });
      setNotice(result.message);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '无法登记审批建议');
    } finally {
      setApprovalBusy(null);
    }
  };

  if (loading && !data) return <LoadingBlock rows={5} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!run || !detail) {
    return (
      <EmptyState
        title="诊断任务不存在"
        description="该任务可能已被删除，或不属于当前工作区。"
        action={
          <Button variant="outline" size="sm" asChild>
            <Link to="/inbox">返回报警收件箱</Link>
          </Button>
        }
      />
    );
  }

  const report = detail.report;
  // 允许补充复核；展示最近一次结论。
  const review =
    detail.reviews.length > 0
      ? detail.reviews[detail.reviews.length - 1]
      : undefined;
  const equipmentName = report?.equipment_snapshot.name ?? run.equipment_id;
  const reportValid = detail.validation?.valid ?? false;

  return (
    <div className="diag-fade-up">
      <div className="mb-4">
        <Link
          to="/inbox"
          className="inline-flex items-center gap-1 text-[11px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="size-3" />
          返回报警收件箱
        </Link>
      </div>

      <PageHeader
        title={equipmentName}
        description={`${run.id} · 时间窗 ${formatTime(run.window.start)} ~ ${formatTime(
          run.window.end,
        )} · 创建于 ${formatTime(run.created_at)}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={reload}>
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
            {active ? (
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  cancelArmed && 'border-red-200 text-red-700 hover:bg-red-50',
                )}
                onClick={handleCancel}
                disabled={cancelling}
              >
                {cancelling ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3.5" />
                )}
                {cancelArmed ? '确认取消' : '取消诊断'}
              </Button>
            ) : null}
            {report ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <a
                    href={diagnosisApi.reportMarkdownUrl(run.id, workspaceId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Download className="size-3.5" />
                    Markdown
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a
                    href={diagnosisApi.reportHtmlUrl(run.id, workspaceId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FileText className="size-3.5" />
                    报告页
                  </a>
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={runDisplayStatus(run)} />
        <ModeBadge mode={run.data_mode} kind="data" />
        <ModeBadge mode={run.model_mode} kind="model" />
        {run.alarm_id ? (
          <Badge
            variant="outline"
            className="rounded-full border-gray-200 text-[10px] text-gray-500"
          >
            关联报警 {run.alarm_id}
          </Badge>
        ) : null}
        {run.symptom ? (
          <span className="min-w-0 truncate text-[11px] text-gray-400">
            症状：{run.symptom}
          </span>
        ) : null}
        {active ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-gray-400">
            <span
              className={cn(
                'size-1.5 rounded-full',
                wsState === 'open'
                  ? 'bg-emerald-500 diag-pulse-dot'
                  : 'bg-gray-300',
              )}
            />
            {wsState === 'open' ? '实时事件已连接' : '轮询刷新中'}
          </span>
        ) : null}
      </div>

      {actionError ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{actionError}</span>
          <button
            type="button"
            className="text-red-500"
            onClick={() => setActionError(null)}
          >
            关闭
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 diag-fade-in">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            className="text-emerald-600"
            onClick={() => setNotice(null)}
          >
            关闭
          </button>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
        <div className="space-y-4">
          {!report ? (
            <Card className="diag-card p-5">
              {run.status === 'failed' ? (
                <div className="flex items-start gap-3">
                  <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" />
                  <div>
                    <div className="text-sm font-medium text-red-800">
                      诊断失败
                    </div>
                    <div className="mt-1 text-xs leading-5 text-gray-600">
                      {run.error ?? '未返回错误详情。'}
                    </div>
                  </div>
                </div>
              ) : run.status === 'cancelled' ? (
                <div className="flex items-start gap-3">
                  <Square className="mt-0.5 size-5 shrink-0 text-gray-500" />
                  <div>
                    <div className="text-sm font-medium text-gray-800">
                      任务已取消
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      已获得的证据保留在右侧证据列表中。
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-blue-600" />
                  <div>
                    <div className="text-sm font-medium text-gray-900">
                      {run.status === 'queued' ? '等待执行' : '正在诊断'}
                    </div>
                    <div className="mt-1 text-xs leading-5 text-gray-500">
                      当前阶段「{stageLabel(run.stage)}
                      」。页面会实时更新，无需手动刷新。
                    </div>
                  </div>
                </div>
              )}
            </Card>
          ) : (
            <>
              <Card className="diag-card overflow-hidden">
                <div className="border-b border-gray-100 px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-gray-900">
                      诊断结论
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px]',
                        report.conclusion_status === 'insufficient_evidence'
                          ? 'border-amber-200 bg-amber-50 text-amber-700'
                          : report.conclusion_status === 'engineer_confirmed'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-blue-200 bg-blue-50 text-blue-700',
                      )}
                    >
                      {report.conclusion_status === 'insufficient_evidence'
                        ? '证据不足'
                        : report.conclusion_status === 'engineer_confirmed'
                          ? '工程师已确认'
                          : '待确认假设'}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px]',
                        report.review_status === 'accepted'
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : report.review_status === 'rejected'
                            ? 'border-red-200 bg-red-50 text-red-700'
                            : 'border-gray-200 bg-gray-50 text-gray-500',
                      )}
                    >
                      复核{' '}
                      {report.review_status === 'accepted'
                        ? '已接受'
                        : report.review_status === 'rejected'
                          ? '已驳回'
                          : '待处理'}
                    </Badge>
                    {detail.validation ? (
                      <span
                        className={cn(
                          'ml-auto inline-flex items-center gap-1 text-[10px]',
                          reportValid ? 'text-emerald-600' : 'text-red-600',
                        )}
                      >
                        {reportValid ? (
                          <ShieldCheck className="size-3" />
                        ) : (
                          <ShieldAlert className="size-3" />
                        )}
                        引用校验 {reportValid ? '通过' : '未通过'}
                        {detail.validation.errors > 0
                          ? ` · ${detail.validation.errors} 个错误`
                          : ''}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="px-5 py-4">
                  {primary ? (
                    <div className="flex items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                        <Sparkles className="size-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h2 className="text-base font-semibold text-gray-950">
                            {rootCauseLabel(primary.code)}
                          </h2>
                          <span className="diag-code text-[10px] text-gray-400">
                            {primary.code}
                          </span>
                          <HypothesisStatusBadge status={primary.status} />
                          <Badge
                            variant="outline"
                            className="rounded-full border-gray-200 text-[10px] text-gray-500"
                          >
                            置信度 {primary.confidence}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-gray-600">
                          {primary.description}
                        </p>
                        <p className="mt-2 text-[11px] leading-5 text-gray-500">
                          {primary.rationale}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <CircleHelp className="size-4" />
                      本次诊断未形成候选根因，请人工判断。
                    </div>
                  )}

                  {report.handoff_reason ? (
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                      <div>
                        <span className="font-medium">转人工原因：</span>
                        {report.handoff_reason}
                      </div>
                    </div>
                  ) : null}

                  {report.limitations.length > 0 ? (
                    <div className="mt-3">
                      <div className="text-[10px] font-medium tracking-wide text-gray-400 uppercase">
                        限制
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {report.limitations.map((item, index) => (
                          <li
                            key={index}
                            className="flex gap-1.5 text-[11px] leading-5 text-gray-500"
                          >
                            <span className="mt-2 size-1 shrink-0 rounded-full bg-gray-300" />
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {detail.validation && !reportValid ? (
                    <div className="mt-3 rounded-lg border border-red-100 bg-red-50/60 px-3 py-2">
                      <div className="text-[10px] font-medium text-red-700">
                        引用校验问题
                      </div>
                      <ul className="mt-1 space-y-0.5 text-[10px] text-red-600">
                        {detail.validation.issues
                          .slice(0, 5)
                          .map((issue, index) => (
                            <li key={index}>
                              {issue.code}: {issue.message}
                            </li>
                          ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </Card>

              <Card className="diag-card p-5">
                <SectionTitle
                  title="候选根因"
                  hint="支持与反证同时保留；点击证据编号查看原文与完整性。"
                />
                <div className="space-y-3">
                  {hypotheses.length === 0 ? (
                    <div className="text-xs text-gray-400">没有候选根因。</div>
                  ) : null}
                  {hypotheses.map((hypothesis) => (
                    <div
                      key={hypothesis.id}
                      className={cn(
                        'rounded-xl border p-3 transition-colors',
                        hypothesis.status === 'supported'
                          ? 'border-emerald-100 bg-emerald-50/30'
                          : hypothesis.status === 'contradicted'
                            ? 'border-gray-100 bg-gray-50/40'
                            : 'border-gray-100 bg-white',
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-gray-900">
                          {hypothesis.title}
                        </span>
                        <span className="diag-code text-[10px] text-gray-400">
                          {hypothesis.code}
                        </span>
                        <HypothesisStatusBadge status={hypothesis.status} />
                        <span className="text-[10px] text-gray-400">
                          置信度 {hypothesis.confidence}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-5 text-gray-600">
                        {hypothesis.description}
                      </p>
                      <p className="mt-1 text-[10px] leading-5 text-gray-400">
                        {hypothesis.rationale}
                      </p>

                      <div className="mt-2 space-y-1.5">
                        {hypothesis.supporting_evidence_ids.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="mr-0.5 text-[10px] text-emerald-700">
                              支持
                            </span>
                            {hypothesis.supporting_evidence_ids.map((id) => (
                              <EvidenceChip
                                key={id}
                                id={id}
                                evidence={evidenceById.get(id)}
                                onOpen={openEvidence}
                              />
                            ))}
                          </div>
                        ) : null}
                        {hypothesis.contradicting_evidence_ids.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="mr-0.5 text-[10px] text-red-600">
                              反证
                            </span>
                            {hypothesis.contradicting_evidence_ids.map((id) => (
                              <EvidenceChip
                                key={id}
                                id={id}
                                evidence={evidenceById.get(id)}
                                tone="contradict"
                                onOpen={openEvidence}
                              />
                            ))}
                          </div>
                        ) : null}
                        {hypothesis.missing_evidence.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="mr-0.5 text-[10px] text-amber-700">
                              缺口
                            </span>
                            {hypothesis.missing_evidence.map((item) => (
                              <span
                                key={item}
                                className="rounded-md border border-amber-100 bg-amber-50/60 px-1.5 py-0.5 text-[10px] text-amber-700"
                              >
                                {item}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {hypothesis.next_check ? (
                          <div className="flex items-start gap-1 text-[10px] text-gray-500">
                            <ChevronRight className="mt-0.5 size-3 shrink-0" />
                            下一步：{hypothesis.next_check}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="diag-card p-5">
                <SectionTitle
                  title="关键观察"
                  hint="每条观察必须引用至少一条证据。"
                />
                <div className="space-y-2">
                  {report.observations.map((observation) => (
                    <div
                      key={observation.id}
                      className="rounded-lg border border-gray-100 px-3 py-2"
                    >
                      <div className="text-[11px] leading-5 text-gray-700">
                        {observation.text}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {observation.evidence_ids.map((id) => (
                          <EvidenceChip
                            key={id}
                            id={id}
                            evidence={evidenceById.get(id)}
                            onOpen={openEvidence}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  {report.observations.length === 0 ? (
                    <div className="text-xs text-gray-400">没有观察记录。</div>
                  ) : null}
                </div>
              </Card>

              <Card className="diag-card p-5">
                <SectionTitle
                  title="检查项与建议"
                  hint="检查动作由工程师执行；控制执行在本版本始终禁用。"
                />
                <div className="space-y-3">
                  {report.checks.map((check) => (
                    <div
                      key={check.id}
                      className="rounded-lg border border-gray-100 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Wrench className="size-3.5 text-gray-400" />
                        <span className="text-xs font-medium text-gray-800">
                          {check.purpose}
                        </span>
                        <Badge
                          variant="outline"
                          className="rounded-full border-gray-200 text-[9px] text-gray-500"
                        >
                          风险 {riskLabel(check.risk)}
                        </Badge>
                        {check.requires_human ? (
                          <Badge
                            variant="outline"
                            className="rounded-full border-amber-200 bg-amber-50 text-[9px] text-amber-700"
                          >
                            需人工
                          </Badge>
                        ) : null}
                      </div>
                      <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-[11px] leading-5 text-gray-600">
                        {check.steps.map((step, index) => (
                          <li key={index}>{step}</li>
                        ))}
                      </ol>
                      {check.expected_observation ? (
                        <div className="mt-1 text-[10px] text-gray-400">
                          预期：{check.expected_observation}
                        </div>
                      ) : null}
                      {check.evidence_ids.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {check.evidence_ids.map((id) => (
                            <EvidenceChip
                              key={id}
                              id={id}
                              evidence={evidenceById.get(id)}
                              onOpen={openEvidence}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}

                  {report.recommendations.map((recommendation) => (
                    <div
                      key={recommendation.id}
                      className="rounded-lg border border-blue-100 bg-blue-50/30 p-3"
                    >
                      <div className="flex items-start gap-2">
                        <Info className="mt-0.5 size-3.5 shrink-0 text-blue-600" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] leading-5 text-gray-700">
                            {recommendation.text}
                          </div>
                          {recommendation.conditions.length > 0 ? (
                            <div className="mt-1 text-[10px] text-gray-400">
                              前提：{recommendation.conditions.join('；')}
                            </div>
                          ) : null}
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {recommendation.evidence_ids.map((id) => (
                              <EvidenceChip
                                key={id}
                                id={id}
                                evidence={evidenceById.get(id)}
                                onOpen={openEvidence}
                              />
                            ))}
                          </div>
                        </div>
                        {run.status === 'awaiting_human' &&
                        recommendation.requires_human ? (
                          <Button
                            variant="outline"
                            size="xs"
                            className="shrink-0 border-blue-200 text-blue-700 hover:bg-blue-50"
                            onClick={() =>
                              handleApproval(
                                recommendation.id,
                                recommendation.text,
                              )
                            }
                            disabled={approvalBusy === recommendation.id}
                          >
                            {approvalBusy === recommendation.id ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <ShieldCheck className="size-3" />
                            )}
                            登记审批建议
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-1 text-[9px] text-gray-400">
                        控制执行：{recommendation.control_execution}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}

          {run.status === 'awaiting_human' || run.status === 'completed' ? (
            <Card className="diag-card p-5">
              <SectionTitle
                title="人工复核"
                hint="复核结论会写回报告状态；高风险控制建议不能由申请人自己批准。"
              />
              {review ? (
                <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-3">
                  <div className="flex items-center gap-2 text-xs">
                    <CheckCircle2
                      className={cn(
                        'size-3.5',
                        review.decision === 'accepted'
                          ? 'text-emerald-600'
                          : 'text-red-600',
                      )}
                    />
                    <span className="font-medium text-gray-800">
                      {review.decision === 'accepted' ? '接受结论' : '驳回结论'}
                    </span>
                    <span className="text-[10px] text-gray-400">
                      {formatTime(review.created_at)}
                    </span>
                  </div>
                  {review.comment ? (
                    <p className="mt-1 text-[11px] leading-5 text-gray-600">
                      {review.comment}
                    </p>
                  ) : null}
                  {review.observations.length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-[10px] text-gray-500">
                      {review.observations.map((item, index) => (
                        <li key={index}>· {item}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {run.review_status === 'pending' ? (
                <div className="mt-3 grid gap-3">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setReviewDecision('accepted')}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors',
                        reviewDecision === 'accepted'
                          ? 'border-emerald-200 bg-emerald-50 font-medium text-emerald-700'
                          : 'border-gray-200 text-gray-500 hover:border-gray-300',
                      )}
                    >
                      <CheckCircle2 className="size-3.5" />
                      接受结论
                    </button>
                    <button
                      type="button"
                      onClick={() => setReviewDecision('rejected')}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors',
                        reviewDecision === 'rejected'
                          ? 'border-red-200 bg-red-50 font-medium text-red-700'
                          : 'border-gray-200 text-gray-500 hover:border-gray-300',
                      )}
                    >
                      <XCircle className="size-3.5" />
                      驳回结论
                    </button>
                  </div>
                  <Textarea
                    value={reviewComment}
                    onChange={(event) => setReviewComment(event.target.value)}
                    placeholder="复核意见（可选）：补充现场判断、指出证据缺口或说明驳回原因。"
                    className="min-h-20 bg-white text-xs"
                    maxLength={4000}
                  />
                  <Textarea
                    value={reviewObservations}
                    onChange={(event) =>
                      setReviewObservations(event.target.value)
                    }
                    placeholder="现场补充观察（每行一条，可选）"
                    className="min-h-16 bg-white text-xs"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] text-gray-400">
                      当前状态：{statusLabel(run.status)}
                    </span>
                    <Button
                      size="sm"
                      className="bg-blue-600 text-white hover:bg-blue-700"
                      onClick={handleReview}
                      disabled={reviewing}
                    >
                      {reviewing ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <MessageSquarePlus className="size-3.5" />
                      )}
                      提交复核
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-lg border border-gray-100 bg-white px-3 py-2 text-[11px] leading-5 text-gray-500">
                  复核已完成。如需调整判断，可补充信息后创建续诊任务；历史结论保留在报告中。
                </div>
              )}

              {run.status === 'awaiting_human' ? (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  {!resumeOpen ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setResumeOpen(true)}
                    >
                      <History className="size-3.5" />
                      补充信息后继续诊断
                    </Button>
                  ) : (
                    <div className="space-y-2 diag-fade-in">
                      <Textarea
                        value={resumeNote}
                        onChange={(event) => setResumeNote(event.target.value)}
                        placeholder="例如：已现场确认轴承座温度，补充 14:00 的检修记录。"
                        className="min-h-16 bg-white text-xs"
                        maxLength={2000}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setResumeOpen(false)}
                        >
                          取消
                        </Button>
                        <Button
                          size="sm"
                          className="bg-blue-600 text-white hover:bg-blue-700"
                          onClick={handleResume}
                          disabled={resuming || !resumeNote.trim()}
                        >
                          {resuming ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <ArrowRight className="size-3.5" />
                          )}
                          创建续诊任务
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              {data?.approvals && data.approvals.length > 0 ? (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <div className="mb-1.5 text-[10px] font-medium tracking-wide text-gray-400 uppercase">
                    审批建议
                  </div>
                  <div className="space-y-1">
                    {data.approvals.map((approval) => (
                      <div
                        key={approval.id}
                        className="flex items-center gap-2 rounded-md border border-gray-100 px-2 py-1.5 text-[10px]"
                      >
                        <span className="diag-code truncate text-gray-500">
                          {approval.action_id}
                        </span>
                        <span className="ml-auto text-gray-400">
                          {riskLabel(approval.risk_level)}
                        </span>
                        <Badge
                          variant="outline"
                          className="rounded-full border-gray-200 text-[9px] text-gray-500"
                        >
                          {approval.status}
                        </Badge>
                        <span className="text-gray-300">
                          {approval.receipt_status ?? '不执行'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card className="diag-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-900">
                运行状态
              </span>
              <span className="text-[10px] text-gray-400">
                用时 {duration(run.started_at, run.finished_at)}
              </span>
            </div>
            <StageTimeline run={run} />
            <div className="mt-4 space-y-2 border-t border-gray-100 pt-3">
              <UsageBar
                label="总轮次"
                used={run.total_rounds}
                max={run.budget.max_rounds_total}
              />
              <UsageBar
                label="工具调用"
                used={run.logical_calls}
                max={run.budget.max_logical_tool_calls}
              />
              <UsageBar
                label="模型调用"
                used={run.model_calls}
                max={run.budget.max_model_calls}
              />
            </div>
            <div className="mt-3 border-t border-gray-100 pt-2">
              <MetaRow label="当前阶段" value={stageLabel(run.stage)} />
              <MetaRow label="诊断模式" value={run.model_mode} />
              <MetaRow label="数据模式" value={run.data_mode} />
              <MetaRow
                label="时间窗"
                value={`${formatTime(run.window.start)} ~ ${formatTime(
                  run.window.end,
                )}`}
              />
              <MetaRow label="开始" value={formatTime(run.started_at)} />
              <MetaRow label="结束" value={formatTime(run.finished_at)} />
            </div>
          </Card>

          <Card className="diag-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-900">
                遥测证据
              </span>
              <Gauge className="size-3.5 text-gray-300" />
            </div>
            <TelemetryChart
              evidence={detail.evidence}
              metrics={data?.equipment?.equipment.metrics ?? {}}
            />
          </Card>

          <Card className="diag-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-900">
                工具调用轨迹
              </span>
              <span className="text-[10px] text-gray-400">
                {detail.tool_calls.length} 条
              </span>
            </div>
            <ToolTrace calls={detail.tool_calls} />
          </Card>

          <Card className="diag-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-900">
                事件流
              </span>
              <span className="text-[10px] text-gray-400">
                {events.length} 条
              </span>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto diag-scroll">
              {events.slice(-30).map((event) => (
                <div
                  key={event.event_id}
                  className="flex items-start gap-2 rounded-md px-1.5 py-1 text-[10px] hover:bg-gray-50"
                >
                  <span className="diag-code w-8 shrink-0 text-gray-300">
                    #{event.seq}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-gray-600">
                      {EVENT_LABELS[event.type] ?? event.type}
                    </span>
                    {event.type === 'stage.changed' &&
                    typeof event.payload.stage === 'string' ? (
                      <span className="ml-1 text-gray-400">
                        {statusLabel(event.payload.stage)}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-gray-300">
                    {formatTime(event.timestamp)}
                  </span>
                </div>
              ))}
              {events.length === 0 ? (
                <div className="py-3 text-center text-[10px] text-gray-400">
                  暂无事件。
                </div>
              ) : null}
            </div>
          </Card>

          {detail.context_manifests.length > 0 ? (
            <Card className="diag-card p-4">
              <div className="mb-2 text-xs font-semibold text-gray-900">
                上下文预算
              </div>
              <div className="space-y-1">
                {detail.context_manifests.map((manifest, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between text-[10px] text-gray-500"
                  >
                    <span>
                      {String(manifest.role)} · {String(manifest.stage)}
                    </span>
                    <span>
                      {String(manifest.estimated_tokens)} tokens
                      {manifest.estimated ? '（估算）' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      <EvidenceDrawer
        evidence={selectedEvidence}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        workspaceId={workspaceId}
      />
    </div>
  );
}
