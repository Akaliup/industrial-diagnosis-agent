import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { diagnosisApi } from '../api';
import { useAuth } from '../auth';
import { useAsync } from '../hooks/useAsync';
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  formatTime,
} from '../components/common';

interface EvalRunRow {
  id: string;
  mode: string;
  split: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  metrics_json: string | null;
  results_json: string | null;
  error: string | null;
}

interface EvalMetricsView {
  total?: number;
  passed?: number;
  citation_integrity?: number;
  unauthorized_calls?: number;
  missed_handoff?: number;
  counter_evidence_retained?: number;
  evidence_coverage?: number;
  required_tool_recall?: number;
  solvable_completion?: number;
  unnecessary_handoff?: number;
  top1_hit?: number | null;
  top3_hit?: number | null;
  tool_selection_accuracy?: number;
  handoff_accuracy?: number;
  task_success_rate?: number;
  mean_latency_ms?: number;
  p95_latency_ms?: number;
  total_tokens?: number;
  model_calls?: number;
  model_call_failures?: number;
  estimated_cost_usd?: number | null;
  multi_fault_coverage?: number | null;
}

interface EvalCaseView {
  case_id: string;
  category: string;
  split: string;
  run_id: string;
  status: string;
  passed: boolean;
  failure_reasons: string[];
  predicted_root_causes: string[];
  required_tools_missing: string[];
  citation_issues: string[];
  handoff: boolean;
  metrics: Record<string, number | boolean | string>;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'good' | 'bad';
}) {
  return (
    <Card className="diag-card px-3 py-2.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-lg font-semibold tracking-tight',
          tone === 'good'
            ? 'text-emerald-700'
            : tone === 'bad'
              ? 'text-red-700'
              : 'text-gray-950',
        )}
      >
        {value}
      </div>
      {hint ? <div className="text-[9px] text-gray-400">{hint}</div> : null}
    </Card>
  );
}

export function EvalPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const { data, loading, error, reload } = useAsync(async () => {
    if (!isAdmin) return { evalRuns: [] as EvalRunRow[] };
    const result = await diagnosisApi.evalRuns();
    return { evalRuns: result.eval_runs as unknown as EvalRunRow[] };
  }, [isAdmin]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [split, setSplit] = useState<'dev' | 'holdout' | 'all'>('all');
  const [limit, setLimit] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [traceCase, setTraceCase] = useState<EvalCaseView | null>(null);
  const [trace, setTrace] = useState<Record<string, unknown> | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);

  const evalRuns = data?.evalRuns ?? [];
  const running = evalRuns.some((row) => row.status === 'running');
  const selected =
    evalRuns.find((row) => row.id === selectedId) ?? evalRuns[0] ?? null;

  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => reloadRef.current(), 2500);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    diagnosisApi
      .evalRun(selected.id)
      .then((result) => {
        if (!cancelled) setDetail(result.eval_run);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setDetailError(
            err instanceof Error ? err.message : '无法读取评测详情',
          );
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.status]);

  const metrics = useMemo<EvalMetricsView>(() => {
    if (detail?.metrics && typeof detail.metrics === 'object') {
      return detail.metrics as EvalMetricsView;
    }
    if (selected) return parseJson<EvalMetricsView>(selected.metrics_json, {});
    return {};
  }, [detail, selected]);

  const results = useMemo<EvalCaseView[]>(() => {
    if (Array.isArray(detail?.results)) return detail.results as EvalCaseView[];
    if (selected) return parseJson<EvalCaseView[]>(selected.results_json, []);
    return [];
  }, [detail, selected]);

  const startEval = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const result = await diagnosisApi.startEval({
        split,
        limit: limit.trim() ? Number(limit) : null,
      });
      setSelectedId(result.eval_run_id);
      reload();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : '无法启动评测');
    } finally {
      setStarting(false);
    }
  };

  const openTrace = async (caseResult: EvalCaseView) => {
    if (!selected) return;
    setTraceCase(caseResult);
    setTrace(null);
    setTraceError(null);
    setTraceLoading(true);
    try {
      const value = await diagnosisApi.trace(selected.id, caseResult.case_id);
      setTrace(value);
    } catch (err) {
      setTraceError(err instanceof Error ? err.message : '无法读取轨迹');
    } finally {
      setTraceLoading(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="diag-fade-up">
        <PageHeader
          title="评测与回放"
          description="50 例离线回归与轨迹回放。"
        />
        <EmptyState
          icon={<ShieldAlert className="size-5" />}
          title="需要管理员权限"
          description="评测结果与轨迹包含完整运行细节，仅管理员可查看和启动。"
        />
      </div>
    );
  }

  return (
    <div className="diag-fade-up">
      <PageHeader
        title="评测与回放"
        description="固定 50 例场景的离线回归：引用完整性、证据覆盖、必需工具召回、反证保留与转人工判断。Fixture 模式不代表真实模型精度。"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={reload}
              disabled={loading}
            >
              <RefreshCw
                className={cn('size-3.5', loading && 'animate-spin')}
              />
              刷新
            </Button>
            <Button
              size="sm"
              className="bg-blue-600 text-white hover:bg-blue-700"
              onClick={startEval}
              disabled={starting || running}
            >
              {starting || running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {running ? '评测运行中' : '运行评测'}
            </Button>
          </>
        }
      />

      <Card className="diag-card mb-4 p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-[10px] font-medium text-gray-500">
              数据集
            </label>
            <select
              value={split}
              onChange={(event) =>
                setSplit(event.target.value as 'dev' | 'holdout' | 'all')
              }
              className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-xs"
              disabled={running}
            >
              <option value="all">全部 50 例</option>
              <option value="dev">Dev 29 例</option>
              <option value="holdout">Holdout 21 例</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-medium text-gray-500">
              限制用例数（可选）
            </label>
            <input
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              inputMode="numeric"
              placeholder="例如 5"
              className="h-8 w-28 rounded-lg border border-gray-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
              disabled={running}
            />
          </div>
          <div className="ml-auto text-[10px] leading-5 text-gray-400">
            评测在独立临时数据库中运行，不写入演示工作区。当前模型模式由服务启动参数固定。
          </div>
        </div>
        {startError ? (
          <div className="mt-2 text-[11px] text-red-600">{startError}</div>
        ) : null}
      </Card>

      {loading && !data ? (
        <LoadingBlock rows={4} />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : evalRuns.length === 0 ? (
        <EmptyState
          icon={<FlaskConical className="size-5" />}
          title="还没有评测记录"
          description="运行一次全部 50 例回归，结果会保存在诊断数据库，并生成逐例轨迹。"
          action={
            <Button
              size="sm"
              className="bg-blue-600 text-white hover:bg-blue-700"
              onClick={startEval}
              disabled={starting}
            >
              {starting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              运行 50 例评测
            </Button>
          }
        />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
          <div>
            <SectionTitle title="评测历史" hint="最近 20 次运行。" />
            <div className="space-y-1.5">
              {evalRuns.map((row) => {
                const rowMetrics = parseJson<EvalMetricsView>(
                  row.metrics_json,
                  {},
                );
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                      selected?.id === row.id
                        ? 'border-blue-200 bg-blue-50/60'
                        : 'border-gray-100 bg-white hover:border-blue-100 hover:bg-gray-50',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          row.status === 'passed'
                            ? 'bg-emerald-500'
                            : row.status === 'running'
                              ? 'bg-blue-500 diag-pulse-dot'
                              : 'bg-red-500',
                        )}
                      />
                      <span className="diag-code truncate text-[10px] text-gray-600">
                        {row.id}
                      </span>
                      <span className="ml-auto text-[9px] text-gray-400">
                        {row.split}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-gray-400">
                      <span>
                        {rowMetrics.passed ?? 0}/{rowMetrics.total ?? 0} 通过
                      </span>
                      <span>{formatTime(row.started_at)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-4">
            {selected ? (
              <>
                <Card className="diag-card p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-gray-900">
                      {selected.id}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        'rounded-full text-[10px]',
                        selected.status === 'passed'
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : selected.status === 'running'
                            ? 'border-blue-200 bg-blue-50 text-blue-700'
                            : 'border-red-200 bg-red-50 text-red-700',
                      )}
                    >
                      {selected.status === 'passed'
                        ? '通过'
                        : selected.status === 'running'
                          ? '运行中'
                          : '未通过'}
                    </Badge>
                    <span className="text-[10px] text-gray-400">
                      {selected.mode} 模式 · {selected.split} · 开始{' '}
                      {formatTime(selected.started_at)} · 结束{' '}
                      {formatTime(selected.finished_at)}
                    </span>
                  </div>
                  {selected.error ? (
                    <div className="mt-2 rounded-md border border-red-100 bg-red-50/60 px-2.5 py-1.5 text-[10px] text-red-700">
                      {selected.error}
                    </div>
                  ) : null}
                  {detailLoading ? (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-gray-400">
                      <Loader2 className="size-3 animate-spin" />
                      读取详情…
                    </div>
                  ) : null}
                  {detailError ? (
                    <div className="mt-2 text-[10px] text-red-600">
                      {detailError}
                    </div>
                  ) : null}
                </Card>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  <MetricCard
                    label="通过率"
                    value={`${metrics.passed ?? 0}/${metrics.total ?? 0}`}
                    tone={
                      (metrics.passed ?? 0) === (metrics.total ?? 0) &&
                      (metrics.total ?? 0) > 0
                        ? 'good'
                        : 'default'
                    }
                  />
                  <MetricCard
                    label="引用完整性"
                    value={percent(metrics.citation_integrity)}
                    tone={
                      (metrics.citation_integrity ?? 0) >= 0.98 ? 'good' : 'bad'
                    }
                  />
                  <MetricCard
                    label="证据覆盖"
                    value={percent(metrics.evidence_coverage)}
                  />
                  <MetricCard
                    label="必需工具召回"
                    value={percent(metrics.required_tool_recall)}
                  />
                  <MetricCard
                    label="Top1 命中"
                    value={percent(metrics.top1_hit)}
                  />
                  <MetricCard
                    label="Top3 命中"
                    value={percent(metrics.top3_hit)}
                  />
                  <MetricCard
                    label="工具选择准确率"
                    value={percent(metrics.tool_selection_accuracy)}
                  />
                  <MetricCard
                    label="反证保留"
                    value={percent(metrics.counter_evidence_retained)}
                  />
                  <MetricCard
                    label="转人工准确率"
                    value={percent(metrics.handoff_accuracy)}
                  />
                  <MetricCard
                    label="任务成功率"
                    value={percent(metrics.task_success_rate)}
                  />
                  <MetricCard
                    label="可解完成率"
                    value={percent(metrics.solvable_completion)}
                  />
                  <MetricCard
                    label="多故障覆盖"
                    value={
                      metrics.multi_fault_coverage === null ||
                      metrics.multi_fault_coverage === undefined
                        ? '—'
                        : percent(metrics.multi_fault_coverage)
                    }
                  />
                  <MetricCard
                    label="越权调用"
                    value={String(metrics.unauthorized_calls ?? 0)}
                    tone={
                      (metrics.unauthorized_calls ?? 0) > 0 ? 'bad' : 'good'
                    }
                  />
                  <MetricCard
                    label="漏转人工"
                    value={String(metrics.missed_handoff ?? 0)}
                    tone={(metrics.missed_handoff ?? 0) > 0 ? 'bad' : 'good'}
                  />
                  <MetricCard
                    label="不必要转人工"
                    value={String(metrics.unnecessary_handoff ?? 0)}
                    tone={
                      (metrics.unnecessary_handoff ?? 0) > 0 ? 'bad' : 'good'
                    }
                  />
                  <MetricCard
                    label="平均延迟"
                    value={`${metrics.mean_latency_ms ?? 0} ms`}
                    hint={`p95 ${metrics.p95_latency_ms ?? 0} ms`}
                  />
                  <MetricCard
                    label="Token 用量"
                    value={String(metrics.total_tokens ?? 0)}
                    hint={`${metrics.model_calls ?? 0} 次调用 / ${metrics.model_call_failures ?? 0} 次失败`}
                  />
                  <MetricCard
                    label="估算成本"
                    value={
                      metrics.estimated_cost_usd === null ||
                      metrics.estimated_cost_usd === undefined
                        ? '未配置单价'
                        : `$${metrics.estimated_cost_usd.toFixed(4)}`
                    }
                  />
                </div>

                <Card className="diag-card overflow-hidden">
                  <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                    <span className="text-xs font-semibold text-gray-900">
                      逐例结果
                    </span>
                    <span className="text-[10px] text-gray-400">
                      点击查看完整轨迹
                    </span>
                  </div>
                  {results.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-gray-400">
                      没有逐例结果（评测可能仍在运行）。
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-50">
                      {results.map((result) => (
                        <button
                          key={result.case_id}
                          type="button"
                          onClick={() => openTrace(result)}
                          className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-gray-50"
                        >
                          {result.passed ? (
                            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />
                          ) : (
                            <XCircle className="size-3.5 shrink-0 text-red-600" />
                          )}
                          <span className="diag-code w-24 shrink-0 text-[10px] text-gray-600">
                            {result.case_id}
                          </span>
                          <span className="hidden w-28 shrink-0 text-[10px] text-gray-400 sm:inline">
                            {result.category}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[10px] text-gray-500">
                            {result.predicted_root_causes.length > 0
                              ? result.predicted_root_causes.join(', ')
                              : '无预测'}
                            {result.failure_reasons.length > 0
                              ? ` · ${result.failure_reasons.join('; ')}`
                              : ''}
                          </span>
                          <ChevronRight className="size-3.5 shrink-0 text-gray-300" />
                        </button>
                      ))}
                    </div>
                  )}
                </Card>
              </>
            ) : null}
          </div>
        </div>
      )}

      <Sheet
        open={Boolean(traceCase)}
        onOpenChange={(open) => {
          if (!open) setTraceCase(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full gap-0 overflow-y-auto p-0 diag-scroll sm:max-w-[640px]"
        >
          <SheetHeader className="border-b border-gray-100 px-5 py-4">
            <SheetTitle className="text-sm">
              轨迹 {traceCase?.case_id}
            </SheetTitle>
            <SheetDescription className="text-[11px] text-gray-500">
              {traceCase?.passed ? '通过' : '未通过'} ·{' '}
              {traceCase?.predicted_root_causes.join(', ') || '无预测'}
              {traceCase?.handoff ? ' · 转人工' : ''}
            </SheetDescription>
          </SheetHeader>
          <div className="px-5 py-4">
            {traceCase && traceCase.failure_reasons.length > 0 ? (
              <div className="mb-3 rounded-lg border border-red-100 bg-red-50/60 px-3 py-2 text-[11px] text-red-700">
                {traceCase.failure_reasons.join('; ')}
              </div>
            ) : null}
            {traceLoading ? (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Loader2 className="size-3.5 animate-spin" />
                读取轨迹…
              </div>
            ) : traceError ? (
              <div className="text-xs text-red-600">{traceError}</div>
            ) : trace ? (
              <pre className="diag-code max-h-[70vh] overflow-auto rounded-lg border border-gray-100 bg-gray-50/60 p-3 text-[10px] leading-5 text-gray-600 diag-scroll">
                {JSON.stringify(trace, null, 2)}
              </pre>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
