import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  BellRing,
  ClipboardList,
  Database,
  Inbox,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { diagnosisApi, type EquipmentView, type RunView } from '../api';
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
  runDisplayStatus,
  statusLabel,
} from '../components/common';

type AlarmFilter = 'all' | 'active' | 'cleared' | 'unknown';

const FILTERS: Array<{ key: AlarmFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '活动' },
  { key: 'cleared', label: '已清除' },
  { key: 'unknown', label: '未知' },
];

export function InboxPage() {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<AlarmFilter>('all');
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync(async () => {
    const [alarmResult, equipmentResult, runResult] = await Promise.all([
      diagnosisApi.alarms({ workspace_id: workspaceId }),
      diagnosisApi.equipment(workspaceId),
      diagnosisApi.runs({ workspace_id: workspaceId, limit: 50 }),
    ]);
    return {
      alarms: alarmResult.alarms,
      equipment: equipmentResult.equipment,
      runs: runResult.runs,
    };
  }, [workspaceId]);

  const equipmentById = useMemo(() => {
    const map = new Map<string, EquipmentView>();
    for (const item of data?.equipment ?? []) map.set(item.equipment_id, item);
    return map;
  }, [data]);

  const latestRunByAlarm = useMemo(() => {
    const map = new Map<string, RunView>();
    for (const run of data?.runs ?? []) {
      if (!run.alarm_id) continue;
      if (!map.has(run.alarm_id)) map.set(run.alarm_id, run);
    }
    return map;
  }, [data]);

  const visibleAlarms = useMemo(() => {
    const alarms = data?.alarms ?? [];
    const filtered =
      filter === 'all'
        ? alarms
        : alarms.filter((alarm) => alarm.state === filter);
    return [...filtered].sort(
      (a, b) => Date.parse(b.raised_at) - Date.parse(a.raised_at),
    );
  }, [data, filter]);

  const stats = useMemo(() => {
    const alarms = data?.alarms ?? [];
    const runs = data?.runs ?? [];
    return {
      active: alarms.filter((alarm) => alarm.state === 'active').length,
      critical: alarms.filter(
        (alarm) => alarm.state === 'active' && alarm.severity === 'critical',
      ).length,
      awaiting: runs.filter(
        (run) =>
          run.status === 'awaiting_human' && run.review_status === 'pending',
      ).length,
      running: runs.filter((run) => run.status === 'running').length,
    };
  }, [data]);

  const handleSeed = async () => {
    setSeeding(true);
    setSeedError(null);
    try {
      await diagnosisApi.demoSeed(workspaceId);
      reload();
    } catch (err) {
      setSeedError(err instanceof Error ? err.message : '演示数据初始化失败');
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="diag-fade-up">
      <PageHeader
        title="报警收件箱"
        description="按严重程度处置报警。诊断只读取设备、工况与知识数据；控制动作仅形成审批建议。"
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
              onClick={() => navigate('/runs/new')}
            >
              <Sparkles className="size-3.5" />
              发起诊断
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          {
            label: '活动报警',
            value: stats.active,
            icon: BellRing,
            tone: 'text-blue-700 bg-blue-50',
          },
          {
            label: '严重报警',
            value: stats.critical,
            icon: ClipboardList,
            tone: 'text-red-700 bg-red-50',
          },
          {
            label: '诊断中',
            value: stats.running,
            icon: Loader2,
            tone: 'text-gray-700 bg-gray-50',
          },
          {
            label: '待复核',
            value: stats.awaiting,
            icon: Inbox,
            tone: 'text-amber-700 bg-amber-50',
          },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <Card key={item.label} className="diag-card px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-500">{item.label}</span>
                <span
                  className={cn(
                    'flex size-6 items-center justify-center rounded-md',
                    item.tone,
                  )}
                >
                  <Icon className="size-3.5" />
                </span>
              </div>
              <div className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
                {item.value}
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="diag-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <div className="flex items-center gap-1 rounded-lg bg-gray-50 p-0.5">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs transition-colors',
                  filter === item.key
                    ? 'bg-white font-medium text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-800',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-gray-400">
            共 {data?.alarms.length ?? 0} 条报警
          </div>
        </div>

        {loading && !data ? (
          <div className="p-4">
            <LoadingBlock rows={4} />
          </div>
        ) : error ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={reload} />
          </div>
        ) : visibleAlarms.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Database className="size-5" />}
              title={
                (data?.alarms.length ?? 0) === 0
                  ? '还没有报警数据'
                  : '当前筛选下没有报警'
              }
              description={
                (data?.alarms.length ?? 0) === 0
                  ? '可以载入 5 个演示场景（传感器漂移、轴承磨损、假报警、多故障与安全转人工），体验完整诊断流程。演示数据均标记为 Mock。'
                  : '切换上方筛选查看其它状态的报警。'
              }
              action={
                (data?.alarms.length ?? 0) === 0 ? (
                  <div className="flex flex-col items-center gap-2">
                    <Button
                      size="sm"
                      className="bg-blue-600 text-white hover:bg-blue-700"
                      onClick={handleSeed}
                      disabled={seeding}
                    >
                      {seeding ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="size-3.5" />
                      )}
                      {seeding ? '正在载入…' : '载入演示数据'}
                    </Button>
                    {seedError ? (
                      <div className="text-[11px] text-red-600">
                        {seedError}
                      </div>
                    ) : null}
                  </div>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="diag-stagger divide-y divide-gray-100">
            {visibleAlarms.map((alarm) => {
              const equipment = equipmentById.get(alarm.equipment_id);
              const run = latestRunByAlarm.get(alarm.id);
              return (
                <div
                  key={alarm.id}
                  className="group flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-blue-50/30 sm:flex-row sm:items-center"
                >
                  <div
                    className={cn(
                      'mt-1 size-2 shrink-0 rounded-full sm:mt-0',
                      alarm.state === 'active'
                        ? alarm.severity === 'critical'
                          ? 'bg-red-500 diag-pulse-dot'
                          : alarm.severity === 'high'
                            ? 'bg-orange-500'
                            : 'bg-amber-500'
                        : 'bg-gray-300',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-gray-900">
                        {equipment?.name ?? alarm.equipment_id}
                      </span>
                      <SeverityBadge severity={alarm.severity} />
                      <span className="rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-500">
                        {alarm.state === 'active'
                          ? '活动'
                          : alarm.state === 'cleared'
                            ? '已清除'
                            : '未知'}
                      </span>
                    </div>
                    <div className="mt-0.5 line-clamp-1 text-xs text-gray-600">
                      <span className="diag-code mr-1.5 text-gray-400">
                        {alarm.code}
                      </span>
                      {alarm.message}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-400">
                      <span>{formatTime(alarm.raised_at)}</span>
                      <span className="diag-code">{alarm.equipment_id}</span>
                      {equipment ? (
                        <span>
                          {equipment.vendor} {equipment.model}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 sm:pl-4">
                    {run ? (
                      <Link
                        to={`/runs/${run.id}`}
                        className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-white px-2.5 py-1 text-[11px] font-medium text-blue-700 transition hover:bg-blue-50"
                      >
                        查看诊断 · {statusLabel(runDisplayStatus(run))}
                        <ArrowUpRight className="size-3" />
                      </Link>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 border-blue-200 text-[11px] text-blue-700 hover:bg-blue-50"
                        onClick={() =>
                          navigate(
                            `/runs/new?alarm_id=${encodeURIComponent(alarm.id)}&equipment_id=${encodeURIComponent(alarm.equipment_id)}`,
                          )
                        }
                      >
                        开始诊断
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="mt-6">
        <SectionTitle
          title="最近诊断"
          hint="按创建时间倒序，点击进入工作台查看证据与报告。"
        />
        <Card className="diag-card divide-y divide-gray-100 overflow-hidden">
          {(data?.runs ?? []).slice(0, 6).map((run) => {
            const equipment = equipmentById.get(run.equipment_id);
            return (
              <Link
                key={run.id}
                to={`/runs/${run.id}`}
                className="flex items-center gap-3 px-4 py-2.5 text-xs transition-colors hover:bg-gray-50"
              >
                <StatusBadge status={runDisplayStatus(run)} />
                <span className="min-w-0 flex-1 truncate font-medium text-gray-800">
                  {equipment?.name ?? run.equipment_id}
                  {run.symptom ? (
                    <span className="ml-1.5 font-normal text-gray-400">
                      {run.symptom}
                    </span>
                  ) : null}
                </span>
                <span className="hidden text-[11px] text-gray-400 sm:inline">
                  {run.total_rounds} 轮 · {run.logical_calls} 次工具
                </span>
                <span className="text-[11px] text-gray-400">
                  {formatTime(run.created_at)}
                </span>
                <ArrowUpRight className="size-3.5 text-gray-300" />
              </Link>
            );
          })}
          {(data?.runs.length ?? 0) === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-gray-400">
              还没有诊断记录。
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
