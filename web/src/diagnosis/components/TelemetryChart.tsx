import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Activity, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Evidence } from '../contracts.generated';

interface MetricInfo {
  unit: string;
  normal_range: [number, number];
}

type SeriesEvidence = Evidence & {
  payload: Extract<Evidence['payload'], { kind: 'telemetry_series' }>;
};

function isSeries(evidence: Evidence): evidence is SeriesEvidence {
  return evidence.payload.kind === 'telemetry_series';
}

function formatTick(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatFull(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function TelemetryChart({
  evidence,
  metrics,
}: {
  evidence: Evidence[];
  metrics: Record<string, MetricInfo>;
}) {
  const series = useMemo(() => evidence.filter(isSeries), [evidence]);
  const [selected, setSelected] = useState<string | null>(null);

  const active = useMemo(() => {
    if (series.length === 0) return null;
    return series.find((item) => item.payload.metric === selected) ?? series[0];
  }, [series, selected]);

  const chartData = useMemo(() => {
    if (!active) return [];
    return active.payload.points.map((point) => ({
      ts: Date.parse(point.t),
      value: point.q === 'missing' ? null : point.v,
      quality: point.q,
      raw: point.v,
    }));
  }, [active]);

  if (series.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-gray-200 bg-gray-50/50 px-3 py-6 text-xs text-gray-400">
        <Activity className="size-4" />
        本次诊断未取到遥测序列证据。
      </div>
    );
  }

  const info = active ? metrics[active.payload.metric] : undefined;
  const qualityIssues = active
    ? active.payload.points.filter((point) => point.q !== 'good').length
    : 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {series.map((item) => {
          const metric = item.payload.metric;
          const isActive = active?.id === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelected(metric)}
              className={cn(
                'rounded-md border px-2 py-1 text-[11px] transition-colors',
                isActive
                  ? 'border-blue-200 bg-blue-50 font-medium text-blue-700'
                  : 'border-gray-200 bg-white text-gray-500 hover:border-blue-200 hover:text-blue-700',
              )}
            >
              {metric}
              <span className="ml-1 text-gray-400">
                {item.payload.unit || info?.unit || ''}
              </span>
            </button>
          );
        })}
      </div>

      {active ? (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
            <span>
              均值{' '}
              <span className="font-medium text-gray-800">
                {active.payload.stats.avg.toFixed(2)} {active.payload.unit}
              </span>
            </span>
            <span>
              范围{' '}
              <span className="font-medium text-gray-800">
                {active.payload.stats.min.toFixed(2)} ~{' '}
                {active.payload.stats.max.toFixed(2)}
              </span>
            </span>
            <span>
              点数{' '}
              <span className="font-medium text-gray-800">
                {active.payload.stats.count}
              </span>
            </span>
            {info ? (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <span className="inline-block h-2 w-3 rounded-sm bg-emerald-100" />
                正常范围 {info.normal_range[0]}~{info.normal_range[1]}{' '}
                {info.unit}
              </span>
            ) : null}
            {qualityIssues > 0 ? (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <AlertCircle className="size-3" />
                {qualityIssues} 个质量异常/缺失点
              </span>
            ) : null}
          </div>

          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 8, right: 12, bottom: 4, left: -8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#f1f5f9"
                  vertical={false}
                />
                {info ? (
                  <ReferenceArea
                    y1={info.normal_range[0]}
                    y2={info.normal_range[1]}
                    fill="#ecfdf5"
                    fillOpacity={0.7}
                    stroke="none"
                  />
                ) : null}
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={formatTick}
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={{ stroke: '#e5e7eb' }}
                  tickLine={false}
                  minTickGap={32}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: '1px solid #e5e7eb',
                    fontSize: 11,
                    boxShadow: '0 8px 24px rgb(15 23 42 / 0.08)',
                  }}
                  labelFormatter={(value) => formatFull(Number(value))}
                  formatter={(value, _name, item) => {
                    const payload = item?.payload as
                      | { quality?: string; raw?: number }
                      | undefined;
                    return [
                      `${value ?? '缺失'} ${active.payload.unit}${
                        payload?.quality && payload.quality !== 'good'
                          ? `（${payload.quality}）`
                          : ''
                      }`,
                      active.payload.metric,
                    ];
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#1d4ed8"
                  strokeWidth={1.6}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1 text-right text-[10px] text-gray-400">
            数据模式 {active.data_mode} · 来源 {active.source_id} · 抓取{' '}
            {formatFull(Date.parse(active.fetched_at))}
          </div>
        </>
      ) : null}
    </div>
  );
}
