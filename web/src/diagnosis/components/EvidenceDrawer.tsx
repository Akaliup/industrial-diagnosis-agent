import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Clock3,
  ExternalLink,
  FileText,
  Fingerprint,
  Hash,
  Loader2,
  MapPin,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { diagnosisApi, type DocumentView } from '../api';
import type { Evidence } from '../contracts.generated';
import { formatTime } from './common';

const KIND_LABELS: Record<string, string> = {
  telemetry_point: '测点快照',
  telemetry_series: '遥测序列',
  alarm: '报警',
  mes_event: 'MES 事件',
  work_order: '工单',
  manual_chunk: '手册原文',
  case_record: '历史案例',
  status_snapshot: '状态快照',
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-xs">
      <span className="shrink-0 text-gray-400">{label}</span>
      <span className="min-w-0 text-right break-words text-gray-700">
        {children}
      </span>
    </div>
  );
}

function PayloadView({ evidence }: { evidence: Evidence }) {
  const payload = evidence.payload;
  switch (payload.kind) {
    case 'manual_chunk':
      return (
        <div>
          <div className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
            <div className="text-[11px] font-medium text-gray-700">
              {payload.document_id}
              {payload.section ? ` · ${payload.section}` : ''}
              <span className="ml-2 font-normal text-gray-400">
                {payload.vendor} {payload.model} / {payload.manual_version}
              </span>
            </div>
            <pre className="diag-code mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 text-gray-700 diag-scroll">
              {payload.excerpt}
            </pre>
          </div>
          <div className="mt-2">
            <Field label="PDF 页码">
              {payload.pdf_page_index}
              {payload.printed_page ? `（印刷页 ${payload.printed_page}）` : ''}
            </Field>
            <Field label="生效日期">{payload.effective_date ?? '—'}</Field>
          </div>
        </div>
      );
    case 'telemetry_series':
      return (
        <div>
          <div className="grid grid-cols-2 gap-2">
            {[
              ['测点', payload.metric],
              ['单位', payload.unit || '—'],
              ['均值', payload.stats.avg.toFixed(2)],
              [
                '范围',
                `${payload.stats.min.toFixed(2)} ~ ${payload.stats.max.toFixed(2)}`,
              ],
              ['点数', String(payload.stats.count)],
              ['缺失', String(payload.stats.missing)],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-lg border border-gray-100 bg-gray-50/70 px-2.5 py-2"
              >
                <div className="text-[10px] text-gray-400">{label}</div>
                <div className="mt-0.5 truncate text-xs font-medium text-gray-800">
                  {value}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-gray-400">
            完整曲线见工作台「遥测证据」。
          </div>
        </div>
      );
    case 'alarm':
      return (
        <div>
          <Field label="报警码">{payload.code}</Field>
          <Field label="事件 ID">{payload.alarm_event_id}</Field>
          <Field label="级别">{payload.severity}</Field>
          <Field label="状态">{payload.state}</Field>
          <Field label="发生时间">{formatTime(payload.raised_at)}</Field>
          <Field label="清除时间">{formatTime(payload.cleared_at)}</Field>
          <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50/70 p-3 text-xs leading-5 text-gray-700">
            {payload.message}
          </div>
        </div>
      );
    case 'work_order':
      return (
        <div>
          <Field label="工单号">{payload.work_order_id}</Field>
          <Field label="标题">{payload.title}</Field>
          <Field label="状态">{payload.status}</Field>
          <Field label="根因">{payload.root_cause_code ?? '—'}</Field>
          <Field label="开始">{formatTime(payload.opened_at)}</Field>
          <Field label="关闭">{formatTime(payload.closed_at)}</Field>
          <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50/70 p-3 text-xs leading-5 text-gray-700">
            {payload.summary}
          </div>
        </div>
      );
    case 'case_record':
      return (
        <div>
          <Field label="案例">{payload.case_id}</Field>
          <Field label="型号">{payload.equipment_model}</Field>
          <Field label="根因">{payload.root_cause_code}</Field>
          <Field label="发生时间">{formatTime(payload.occurred_at)}</Field>
          <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50/70 p-3 text-xs leading-5 text-gray-700">
            {payload.summary}
          </div>
        </div>
      );
    case 'status_snapshot':
      return (
        <div>
          <Field label="设备状态">{payload.state}</Field>
          <Field label="模式">{payload.mode ?? '—'}</Field>
          <Field label="最后在线">{formatTime(payload.last_seen)}</Field>
          <div className="mt-2 overflow-hidden rounded-lg border border-gray-100">
            {payload.points.map((point) => (
              <div
                key={`${point.metric}-${point.at}`}
                className="flex items-center justify-between border-b border-gray-50 px-2.5 py-1.5 text-[11px] last:border-b-0"
              >
                <span className="text-gray-500">{point.metric}</span>
                <span className="font-medium text-gray-800">
                  {point.value} {point.unit}
                </span>
                <span className="text-gray-400">{point.quality}</span>
              </div>
            ))}
          </div>
        </div>
      );
    default:
      return (
        <pre className="diag-code max-h-72 overflow-auto rounded-lg border border-gray-100 bg-gray-50/70 p-3 text-[10px] leading-5 text-gray-600 diag-scroll">
          {JSON.stringify(payload, null, 2)}
        </pre>
      );
  }
}

export function EvidenceDrawer({
  evidence,
  open,
  onOpenChange,
  workspaceId,
}: {
  evidence: Evidence | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string;
}) {
  const [document, setDocument] = useState<DocumentView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !evidence) return;
    let cancelled = false;
    setDocument(null);
    setError(null);
    setLoading(true);
    diagnosisApi
      .evidence(evidence.run_id, evidence.id, workspaceId)
      .then((result) => {
        if (!cancelled) setDocument(result.document);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : '无法读取证据详情');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, evidence, workspaceId]);

  if (!evidence) return null;

  const kind = evidence.payload.kind;
  const isManual = kind === 'manual_chunk';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto p-0 diag-scroll sm:max-w-[540px]"
      >
        <SheetHeader className="border-b border-gray-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="rounded-full border-blue-100 bg-blue-50 text-[10px] text-blue-700"
            >
              {KIND_LABELS[kind] ?? kind}
            </Badge>
            <span className="diag-code text-[11px] text-gray-400">
              {evidence.id}
            </span>
          </div>
          <SheetTitle className="mt-1 text-sm text-gray-950">
            {isManual
              ? '手册原文证据'
              : kind === 'telemetry_series'
                ? '遥测序列证据'
                : '证据详情'}
          </SheetTitle>
          <SheetDescription className="text-[11px] text-gray-500">
            来源 {evidence.source_id} · 数据模式 {evidence.data_mode} · 抓取{' '}
            {formatTime(evidence.fetched_at)}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Loader2 className="size-3.5 animate-spin" />
              读取证据详情…
            </div>
          ) : null}
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </div>
          ) : null}

          <section>
            <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
              内容
            </h3>
            <PayloadView evidence={evidence} />
          </section>

          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
              <MapPin className="size-3" />
              定位
            </h3>
            <div className="rounded-lg border border-gray-100 px-3 py-1.5">
              <Field label="定位类型">
                {evidence.locator.kind === 'db'
                  ? '数据库记录'
                  : evidence.locator.kind === 'file'
                    ? '文件'
                    : 'URL'}
              </Field>
              <Field label="引用">
                <span className="diag-code text-[10px]">
                  {evidence.locator.ref}
                </span>
              </Field>
              {evidence.locator.page ? (
                <Field label="页码">{evidence.locator.page}</Field>
              ) : null}
              {evidence.observed_at ? (
                <Field label="观测时间">
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="size-3 text-gray-400" />
                    {formatTime(evidence.observed_at)}
                  </span>
                </Field>
              ) : null}
              {evidence.equipment_id ? (
                <Field label="设备">{evidence.equipment_id}</Field>
              ) : null}
            </div>
          </section>

          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
              <Fingerprint className="size-3" />
              完整性与质量
            </h3>
            <div className="rounded-lg border border-gray-100 px-3 py-1.5">
              <Field label="Payload hash">
                <span className="diag-code text-[10px]">
                  {evidence.payload_hash}
                </span>
              </Field>
              <Field label="Query hash">
                <span className="diag-code text-[10px]">
                  {evidence.query_hash}
                </span>
              </Field>
              <Field label="源记录">{evidence.source_record_id}</Field>
              <div className="flex flex-wrap justify-end gap-1 py-1.5">
                {evidence.quality_flags.map((flag) => (
                  <Badge
                    key={flag}
                    variant="outline"
                    className={
                      flag === 'good'
                        ? 'rounded-full border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700'
                        : 'rounded-full border-amber-200 bg-amber-50 text-[10px] text-amber-700'
                    }
                  >
                    {flag}
                  </Badge>
                ))}
              </div>
            </div>
          </section>

          {isManual && document ? (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
                <BookOpen className="size-3" />
                手册文件
              </h3>
              <div className="rounded-lg border border-gray-100 px-3 py-2">
                <div className="flex items-center gap-2">
                  <FileText className="size-4 text-gray-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-gray-800">
                      {document.title}
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {document.vendor} {document.model} ·{' '}
                      {document.manual_version} · {document.status}
                    </div>
                  </div>
                  <a
                    href={diagnosisApi.documentUrl(
                      document.document_id,
                      workspaceId,
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[10px] font-medium text-gray-600 transition hover:border-blue-200 hover:text-blue-700"
                  >
                    打开
                    <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
            </section>
          ) : null}

          <div className="flex items-center gap-1.5 border-t border-gray-100 pt-3 text-[10px] text-gray-400">
            <Hash className="size-3" />
            证据在入库时冻结；报告引用必须匹配当前 Run 作用域与 payload hash。
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
