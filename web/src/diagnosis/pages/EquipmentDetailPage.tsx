import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Cpu,
  Database,
  Gauge,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { diagnosisApi } from '../api';
import { useWorkspace } from '../workspace';
import { useAsync } from '../hooks/useAsync';
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  SectionTitle,
  SeverityBadge,
  StatusBadge,
  formatTime,
} from '../components/common';

export function EquipmentDetailPage() {
  const { equipmentId } = useParams<{ equipmentId: string }>();
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();

  const { data, loading, error, reload } = useAsync(
    () => diagnosisApi.equipmentDetail(equipmentId!, workspaceId),
    [equipmentId, workspaceId],
  );

  if (loading && !data) return <LoadingBlock rows={4} />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) {
    return (
      <EmptyState
        title="设备不存在"
        description="该设备可能已被移除，或不属于当前工作区。"
        action={
          <Button variant="outline" size="sm" asChild>
            <Link to="/equipment">返回设备台账</Link>
          </Button>
        }
      />
    );
  }

  const { equipment, alarms, runs, sources } = data;
  const sourceName = new Map(sources.map((source) => [source.id, source.name]));

  return (
    <div className="diag-fade-up">
      <div className="mb-4">
        <Link
          to="/equipment"
          className="inline-flex items-center gap-1 text-[11px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="size-3" />
          返回设备台账
        </Link>
      </div>

      <PageHeader
        title={equipment.name}
        description={`${equipment.vendor} ${equipment.model} · 序列号 ${equipment.serial} · ${equipment.asset_category}`}
        actions={
          <>
            {equipment.manual_document_id ? (
              <Button variant="outline" size="sm" asChild>
                <a
                  href={diagnosisApi.documentUrl(
                    equipment.manual_document_id,
                    workspaceId,
                  )}
                  target="_blank"
                  rel="noreferrer"
                >
                  <BookOpen className="size-3.5" />
                  查看主手册
                </a>
              </Button>
            ) : null}
            <Button
              size="sm"
              className="bg-blue-600 text-white hover:bg-blue-700"
              onClick={() =>
                navigate(
                  `/runs/new?equipment_id=${encodeURIComponent(equipment.equipment_id)}`,
                )
              }
            >
              <Sparkles className="size-3.5" />
              发起诊断
            </Button>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Card className="diag-card p-5">
            <SectionTitle
              title="测点与正常范围"
              hint="诊断按这些测点定位异常；单位与量程来自设备登记信息。"
            />
            <div className="overflow-hidden rounded-lg border border-gray-100">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-gray-100 bg-gray-50/80 px-3 py-1.5 text-[10px] font-medium text-gray-400">
                <span>测点</span>
                <span className="text-right">单位</span>
                <span className="text-right">正常范围</span>
              </div>
              {Object.entries(equipment.metrics).map(([metric, info]) => (
                <div
                  key={metric}
                  className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-gray-50 px-3 py-2 text-[11px] last:border-b-0"
                >
                  <span className="flex items-center gap-1.5 font-medium text-gray-700">
                    <Gauge className="size-3 text-gray-300" />
                    {metric}
                  </span>
                  <span className="text-right text-gray-500">{info.unit}</span>
                  <span className="diag-code text-right text-gray-600">
                    {info.normal_range[0]} ~ {info.normal_range[1]}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="diag-card p-5">
            <SectionTitle
              title="最近报警"
              hint="报警按发生时间倒序；点击可直接发起诊断。"
            />
            <div className="space-y-1.5">
              {alarms.slice(0, 8).map((alarm) => (
                <div
                  key={alarm.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-100 px-3 py-2"
                >
                  <SeverityBadge severity={alarm.severity} />
                  <span className="diag-code text-[10px] text-gray-400">
                    {alarm.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-gray-600">
                    {alarm.message}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {formatTime(alarm.raised_at)}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-blue-700"
                    onClick={() =>
                      navigate(
                        `/runs/new?alarm_id=${encodeURIComponent(
                          alarm.id,
                        )}&equipment_id=${encodeURIComponent(equipment.equipment_id)}`,
                      )
                    }
                  >
                    诊断
                  </Button>
                </div>
              ))}
              {alarms.length === 0 ? (
                <div className="py-4 text-center text-xs text-gray-400">
                  没有报警记录。
                </div>
              ) : null}
            </div>
          </Card>

          <Card className="diag-card p-5">
            <SectionTitle
              title="诊断历史"
              hint="点击进入工作台查看证据与报告。"
            />
            <div className="space-y-1.5">
              {runs.map((run) => (
                <Link
                  key={run.id}
                  to={`/runs/${run.id}`}
                  className="flex items-center gap-2 rounded-lg border border-gray-100 px-3 py-2 transition-colors hover:bg-gray-50"
                >
                  <StatusBadge status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-gray-600">
                    {run.symptom ?? run.id}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {formatTime(run.created_at)}
                  </span>
                  <ArrowUpRight className="size-3.5 text-gray-300" />
                </Link>
              ))}
              {runs.length === 0 ? (
                <div className="py-4 text-center text-xs text-gray-400">
                  还没有诊断记录。
                </div>
              ) : null}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="diag-card p-4">
            <div className="text-xs font-semibold text-gray-900">设备档案</div>
            <div className="mt-2 space-y-1.5 text-[11px]">
              {[
                ['设备 ID', equipment.equipment_id],
                ['厂商', equipment.vendor],
                ['型号', equipment.model],
                ['序列号', equipment.serial],
                ['资产类别', equipment.asset_category],
                ['主手册', equipment.manual_document_id ?? '未登记'],
                ['手册版本', equipment.manual_version ?? '—'],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-start justify-between gap-3 border-b border-gray-50 pb-1.5 last:border-b-0"
                >
                  <span className="shrink-0 text-gray-400">{label}</span>
                  <span className="min-w-0 text-right break-words text-gray-700">
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="diag-card p-4">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-900">
              <Database className="size-3.5 text-gray-400" />
              数据来源
            </div>
            <div className="mt-2 space-y-1.5">
              {Object.entries(equipment.source_ids).map(([kind, sourceId]) => (
                <div
                  key={kind}
                  className="flex items-center justify-between rounded-md border border-gray-100 px-2 py-1.5 text-[10px]"
                >
                  <span className="text-gray-500">{kind}</span>
                  <span className="diag-code truncate text-gray-600">
                    {sourceName.get(sourceId) ?? sourceId}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="diag-card p-4">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-900">
              <Cpu className="size-3.5 text-gray-400" />
              诊断边界
            </div>
            <p className="mt-2 text-[11px] leading-5 text-gray-500">
              该设备仅参与只读诊断。任何控制类建议都必须经人工审批登记；本版本不会向设备发送控制指令。
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
