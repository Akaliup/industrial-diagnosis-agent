import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  Clock3,
  Database,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTime } from './common';

interface ToolCallRow {
  id?: string;
  logical_call_id?: string;
  attempt?: number;
  tool?: string;
  role?: string;
  args_json?: string;
  status?: string;
  error_code?: string | null;
  duration_ms?: number;
  evidence_count?: number;
  policy_decision?: string;
  started_at?: string;
}

const POLICY_LABELS: Record<string, string> = {
  allowed: '允许',
  cached: '缓存复用',
  repeated: '重复拒绝',
  role_not_allowed: '角色不允许',
  tool_not_allowed: '工具不允许',
  schema_invalid: '参数不合规',
  equipment_scope: '设备越界',
  budget_exceeded: '预算超限',
  cancelled: '已取消',
};

const STATUS_LABELS: Record<string, string> = {
  success: '成功',
  partial: '部分',
  no_data: '无数据',
  error: '错误',
  inflight: '进行中',
  unknown: '回执未知',
  cancelled: '已取消',
};

function parseArgs(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value ?? {}, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function ToolTrace({
  calls,
}: {
  calls: Array<Record<string, unknown>>;
}) {
  const rows = calls as ToolCallRow[];
  const [openId, setOpenId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, ToolCallRow[]>();
    for (const row of rows) {
      const key = row.logical_call_id ?? row.id ?? String(Math.random());
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    return [...map.values()].sort(
      (a, b) =>
        Date.parse(a[0]?.started_at ?? '') - Date.parse(b[0]?.started_at ?? ''),
    );
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/50 px-3 py-6 text-center text-xs text-gray-400">
        还没有工具调用记录。
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-100">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 border-b border-gray-100 bg-gray-50/80 px-3 py-1.5 text-[10px] font-medium text-gray-400">
        <span>工具 / 角色</span>
        <span>策略</span>
        <span className="text-right">耗时</span>
        <span className="text-right">证据</span>
      </div>
      <div className="divide-y divide-gray-50">
        {grouped.map((attempts, index) => {
          const first = attempts[0];
          const last = attempts[attempts.length - 1];
          const key = first.logical_call_id ?? first.id ?? String(index);
          const expanded = openId === key;
          const error = attempts.find((item) => item.error_code);
          const status = last?.status ?? 'error';
          const Icon =
            status === 'success'
              ? CheckCircle2
              : status === 'partial' || status === 'unknown'
                ? AlertTriangle
                : status === 'no_data' ||
                    status === 'cancelled' ||
                    status === 'inflight'
                  ? CircleSlash
                  : XCircle;
          const repeated = attempts.some(
            (item) =>
              item.policy_decision === 'repeated' ||
              item.policy_decision === 'cached',
          );
          const duration = attempts.reduce(
            (total, item) => total + (item.duration_ms ?? 0),
            0,
          );
          const evidenceCount = attempts.reduce(
            (total, item) => total + (item.evidence_count ?? 0),
            0,
          );
          return (
            <div key={key}>
              <button
                type="button"
                onClick={() => setOpenId(expanded ? null : key)}
                className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-gray-50"
                aria-expanded={expanded}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Icon
                    className={cn(
                      'size-3.5 shrink-0',
                      status === 'success'
                        ? 'text-emerald-600'
                        : status === 'partial' || status === 'no_data'
                          ? 'text-amber-600'
                          : 'text-red-600',
                    )}
                  />
                  <span className="truncate text-xs font-medium text-gray-800">
                    {first.tool}
                  </span>
                  <span className="hidden truncate text-[10px] text-gray-400 sm:inline">
                    {first.role}
                  </span>
                  {attempts.length > 1 ? (
                    <span className="rounded bg-gray-100 px-1 text-[9px] text-gray-500">
                      {attempts.length} 次
                    </span>
                  ) : null}
                  {repeated ? (
                    <span className="rounded bg-blue-50 px-1 text-[9px] text-blue-600">
                      复用
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[9px]',
                    last?.policy_decision === 'allowed'
                      ? 'bg-emerald-50 text-emerald-700'
                      : last?.policy_decision === 'cached'
                        ? 'bg-blue-50 text-blue-700'
                        : 'bg-red-50 text-red-700',
                  )}
                >
                  {POLICY_LABELS[last?.policy_decision ?? ''] ??
                    last?.policy_decision ??
                    '—'}
                </span>
                <span className="flex items-center justify-end gap-0.5 text-[10px] text-gray-400">
                  <Clock3 className="size-2.5" />
                  {duration}ms
                </span>
                <span className="flex items-center justify-end gap-0.5 text-[10px] text-gray-400">
                  <Database className="size-2.5" />
                  {evidenceCount}
                  <ChevronDown
                    className={cn(
                      'ml-0.5 size-3 transition-transform',
                      expanded && 'rotate-180',
                    )}
                  />
                </span>
              </button>
              {expanded ? (
                <div className="border-t border-gray-50 bg-gray-50/40 px-3 py-2 diag-fade-in">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-400">
                    <span className="diag-code">{key}</span>
                    <span>{STATUS_LABELS[status] ?? status}</span>
                    <span>{formatTime(last?.started_at)}</span>
                    {error ? (
                      <span className="inline-flex items-center gap-1 text-red-600">
                        <ShieldAlert className="size-3" />
                        {error.error_code}
                      </span>
                    ) : null}
                  </div>
                  <pre className="diag-code max-h-48 overflow-auto whitespace-pre-wrap text-[10px] leading-4 text-gray-600 diag-scroll">
                    {parseArgs(first.args_json)}
                  </pre>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
