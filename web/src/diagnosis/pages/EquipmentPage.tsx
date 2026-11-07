import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BookOpen, Cpu, Gauge, Search } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { diagnosisApi } from '../api';
import { useWorkspace } from '../workspace';
import { useAsync } from '../hooks/useAsync';
import {
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  formatTime,
} from '../components/common';

export function EquipmentPage() {
  const { workspaceId } = useWorkspace();
  const [query, setQuery] = useState('');

  const { data, loading, error, reload } = useAsync(async () => {
    const [equipmentResult, alarmResult, runResult] = await Promise.all([
      diagnosisApi.equipment(workspaceId),
      diagnosisApi.alarms({ workspace_id: workspaceId }),
      diagnosisApi.runs({ workspace_id: workspaceId, limit: 100 }),
    ]);
    return {
      equipment: equipmentResult.equipment,
      alarms: alarmResult.alarms,
      runs: runResult.runs,
    };
  }, [workspaceId]);

  const filtered = useMemo(() => {
    const items = data?.equipment ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.name, item.vendor, item.model, item.serial, item.equipment_id]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [data, query]);

  const statsByEquipment = useMemo(() => {
    const map = new Map<
      string,
      { active: number; runs: number; lastRun: string | null }
    >();
    for (const item of data?.equipment ?? []) {
      map.set(item.equipment_id, { active: 0, runs: 0, lastRun: null });
    }
    for (const alarm of data?.alarms ?? []) {
      if (alarm.state !== 'active') continue;
      const entry = map.get(alarm.equipment_id);
      if (entry) entry.active += 1;
    }
    for (const run of data?.runs ?? []) {
      const entry = map.get(run.equipment_id);
      if (!entry) continue;
      entry.runs += 1;
      if (
        !entry.lastRun ||
        Date.parse(run.created_at) > Date.parse(entry.lastRun)
      ) {
        entry.lastRun = run.created_at;
      }
    }
    return map;
  }, [data]);

  return (
    <div className="diag-fade-up">
      <PageHeader
        title="设备台账"
        description="设备、测点与知识手册的统一索引。诊断只会读取当前工作区已登记的设备。"
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-gray-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索设备、型号或序列号"
              className="h-8 w-64 bg-white pl-8 text-xs"
            />
          </div>
        }
      />

      {loading && !data ? (
        <LoadingBlock rows={4} />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Cpu className="size-5" />}
          title={query ? '没有匹配的设备' : '还没有设备台账'}
          description={
            query
              ? '尝试更换关键词，或清空搜索。'
              : '在报警收件箱载入演示数据后，这里会出现 3 台演示设备。'
          }
        />
      ) : (
        <div className="diag-stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => {
            const stats = statsByEquipment.get(item.equipment_id);
            return (
              <Link
                key={item.equipment_id}
                to={`/equipment/${item.equipment_id}`}
              >
                <Card className="diag-card diag-card-hover h-full p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-9 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                        <Cpu className="size-4" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-gray-950">
                          {item.name}
                        </div>
                        <div className="mt-0.5 text-[10px] text-gray-400">
                          {item.vendor} {item.model} · {item.serial}
                        </div>
                      </div>
                    </div>
                    <ArrowUpRight className="size-4 text-gray-300" />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span className="diag-code rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-500">
                      {item.equipment_id}
                    </span>
                    <span className="rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-500">
                      {item.asset_category}
                    </span>
                    {stats?.active ? (
                      <span className="rounded-md border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">
                        {stats.active} 条活动报警
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 border-t border-gray-100 pt-2.5 text-[10px]">
                    <div className="flex items-center gap-1 text-gray-500">
                      <Gauge className="size-3 text-gray-300" />
                      {Object.keys(item.metrics).length} 个测点
                    </div>
                    <div className="flex items-center gap-1 text-gray-500">
                      <BookOpen className="size-3 text-gray-300" />
                      {item.manual_version ?? '未登记手册'}
                    </div>
                    <div className="text-gray-400">
                      诊断 {stats?.runs ?? 0} 次
                    </div>
                    <div className="truncate text-right text-gray-400">
                      最近 {stats?.lastRun ? formatTime(stats.lastRun) : '—'}
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
