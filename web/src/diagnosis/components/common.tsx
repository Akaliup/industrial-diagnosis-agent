import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-gray-950">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-500">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export function SectionTitle({
  title,
  hint,
  actions,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-gray-500">{hint}</p> : null}
      </div>
      {actions}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '诊断中',
  awaiting_human: '等待复核',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  reviewed_accepted: '已复核 · 接受',
  reviewed_rejected: '已复核 · 驳回',
};

// 复核结果写回 run.review_status，但任务状态仍停留在 awaiting_human 以允许续诊；
// 展示层用派生状态，避免把已复核任务继续算作“待复核”。
export function runDisplayStatus(run: {
  status: string;
  review_status?: string;
}): string {
  if (run.status === 'awaiting_human') {
    if (run.review_status === 'accepted') return 'reviewed_accepted';
    if (run.review_status === 'rejected') return 'reviewed_rejected';
  }
  return run.status;
}

const STAGE_LABELS: Record<string, string> = {
  confirm_status: '确认状态',
  locate_anomaly: '定位异常',
  generate_hypotheses: '生成假设',
  verify_evidence: '验证证据',
  produce_report: '生成报告',
};

const ROOT_CAUSE_LABELS: Record<string, string> = {
  sensor_drift: '传感器漂移',
  sensor_stuck: '测点卡值',
  sensor_range: '量程异常',
  bearing_wear: '轴承磨损',
  misalignment: '联轴器不对中',
  lubrication: '润滑不良',
  sampling_gap: '采样缺口',
  false_alarm_threshold: '阈值误报',
  false_alarm_comm: '通讯假报警',
  false_alarm_time: '时钟假报警',
  false_alarm_recovered: '短时报警已恢复',
  insufficient_evidence: '证据不足',
  unknown: '未分类异常',
  multi_fault: '多项并发异常',
};

const RISK_LABELS: Record<string, string> = {
  read: '只读',
  knowledge_read: '知识只读',
  control_intent: '控制意图',
  control: '控制',
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function rootCauseLabel(code: string): string {
  return ROOT_CAUSE_LABELS[code] ?? code;
}

export function riskLabel(risk: string): string {
  return RISK_LABELS[risk] ?? risk;
}

export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    queued: 'border-gray-200 bg-gray-50 text-gray-600',
    running: 'border-blue-200 bg-blue-50 text-blue-700',
    awaiting_human: 'border-amber-200 bg-amber-50 text-amber-700',
    completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    failed: 'border-red-200 bg-red-50 text-red-700',
    cancelled: 'border-gray-200 bg-gray-100 text-gray-500',
    reviewed_accepted: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    reviewed_rejected: 'border-red-200 bg-red-50 text-red-700',
  };
  const Icon =
    status === 'running'
      ? Loader2
      : status === 'awaiting_human'
        ? Clock3
        : status === 'failed' || status === 'reviewed_rejected'
          ? XCircle
          : status === 'completed' || status === 'reviewed_accepted'
            ? CheckCircle2
            : CircleDashed;
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        styles[status],
      )}
    >
      <Icon className={cn('size-3', status === 'running' && 'animate-spin')} />
      {statusLabel(status)}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    critical: 'border-red-200 bg-red-50 text-red-700',
    high: 'border-orange-200 bg-orange-50 text-orange-700',
    medium: 'border-amber-200 bg-amber-50 text-amber-700',
    low: 'border-gray-200 bg-gray-50 text-gray-600',
  };
  return (
    <Badge
      variant="outline"
      className={cn('rounded-full px-2 py-0.5 text-[11px]', styles[severity])}
    >
      {riskLabel(severity)}
    </Badge>
  );
}

export function ModeBadge({
  mode,
  kind = 'data',
}: {
  mode: string;
  kind?: 'data' | 'model' | 'source';
}) {
  const mock = mode === 'mock' || mode === 'fixture';
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        mock
          ? 'border-blue-200 bg-blue-50 text-blue-700'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700',
      )}
    >
      {kind === 'model'
        ? mode === 'fixture'
          ? '预录演示推理'
          : '真实模型'
        : kind === 'source'
          ? mode === 'mock'
            ? 'Mock'
            : mode === 'replay'
              ? '回放'
              : '实时'
          : mode === 'mock'
            ? '模拟数据'
            : mode === 'replay'
              ? '回放数据'
              : '实时数据'}
    </Badge>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Card className="diag-card flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-gray-200 bg-gray-50 text-gray-400">
        {icon ?? <CircleDashed className="size-5" />}
      </div>
      <div>
        <div className="text-sm font-medium text-gray-900">{title}</div>
        {description ? (
          <div className="mx-auto mt-1 max-w-md text-xs leading-5 text-gray-500">
            {description}
          </div>
        ) : null}
      </div>
      {action}
    </Card>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '请求失败';
  return (
    <Card className="diag-card border-red-200 bg-red-50/60 px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-red-800">加载失败</div>
          <div className="mt-0.5 break-words text-xs text-red-700">
            {message}
          </div>
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 transition hover:bg-red-50"
          >
            重试
          </button>
        ) : null}
      </div>
    </Card>
  );
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <Card key={index} className="diag-card p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </Card>
      ))}
    </div>
  );
}

export function InlineWarning({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatDateTimeLocal(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function toUtcIso(localValue: string): string {
  return new Date(localValue).toISOString();
}

export function duration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '—';
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
