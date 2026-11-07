import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  BellRing,
  Clock3,
  Cpu,
  FileSearch,
  Gauge,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { diagnosisApi, type AlarmView, type EquipmentView } from '../api';
import { useWorkspace } from '../workspace';
import { useAsync } from '../hooks/useAsync';
import {
  ErrorState,
  PageHeader,
  SeverityBadge,
  formatDateTimeLocal,
  formatTime,
  toUtcIso,
} from '../components/common';

const STAGES = [
  { name: '确认状态', text: '核对设备在线状态、测点质量与采样缺口。' },
  { name: '定位异常', text: '在时间窗内定位异常测点、起止时间与量级。' },
  { name: '生成假设', text: '结合手册、历史工单与相似案例提出候选根因。' },
  { name: '验证证据', text: '为每个假设寻找支持与反证，保留反证。' },
  { name: '生成报告', text: '输出带引用的报告；证据不足时明确转人工。' },
];

function defaultWindow(alarm: AlarmView | null): {
  start: string;
  end: string;
} {
  const anchor = alarm ? Date.parse(alarm.raised_at) : Date.now();
  const start = new Date(anchor - 30 * 60 * 1000);
  const end = new Date(anchor + 30 * 60 * 1000);
  return {
    start: formatDateTimeLocal(start.toISOString()),
    end: formatDateTimeLocal(end.toISOString()),
  };
}

export function NewRunPage() {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryAlarmId = searchParams.get('alarm_id');
  const queryEquipmentId = searchParams.get('equipment_id');

  const { data, loading, error, reload } = useAsync(async () => {
    const [equipmentResult, alarmResult] = await Promise.all([
      diagnosisApi.equipment(workspaceId),
      diagnosisApi.alarms({ workspace_id: workspaceId }),
    ]);
    return {
      equipment: equipmentResult.equipment,
      alarms: alarmResult.alarms,
    };
  }, [workspaceId]);

  const [equipmentId, setEquipmentId] = useState('');
  const [alarmId, setAlarmId] = useState(queryAlarmId ?? '');
  const [window, setWindow] = useState(() => defaultWindow(null));
  const [symptom, setSymptom] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const equipment = data?.equipment ?? [];
  const alarms = data?.alarms ?? [];

  const selectedEquipment: EquipmentView | null = useMemo(
    () => equipment.find((item) => item.equipment_id === equipmentId) ?? null,
    [equipment, equipmentId],
  );
  const selectedAlarm: AlarmView | null = useMemo(
    () => alarms.find((item) => item.id === alarmId) ?? null,
    [alarms, alarmId],
  );
  const equipmentAlarms = useMemo(
    () => alarms.filter((alarm) => alarm.equipment_id === equipmentId),
    [alarms, equipmentId],
  );

  useEffect(() => {
    if (initialized || equipment.length === 0) return;
    const preferred =
      equipment.find((item) => item.equipment_id === queryEquipmentId) ??
      equipment[0];
    setEquipmentId(preferred.equipment_id);
    setInitialized(true);
  }, [equipment, initialized, queryEquipmentId]);

  // 同一个 SPA 会话内从收件箱再次跳转时，路由组件会复用；需要同步新的查询参数。
  useEffect(() => {
    if (queryEquipmentId) setEquipmentId(queryEquipmentId);
  }, [queryEquipmentId]);

  useEffect(() => {
    setAlarmId(queryAlarmId ?? '');
  }, [queryAlarmId]);

  useEffect(() => {
    if (!initialized) return;
    if (selectedAlarm) {
      setWindow(defaultWindow(selectedAlarm));
      setSymptom(selectedAlarm.message);
    } else if (queryAlarmId && !selectedAlarm && data) {
      // 报警可能已清除，不在活动列表中；仍允许按设备继续。
      setWindow(defaultWindow(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAlarm?.id, initialized]);

  const windowError = useMemo(() => {
    if (!window.start || !window.end) return '请选择完整的诊断时间窗';
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return '时间格式无效';
    if (start >= end) return '开始时间必须早于结束时间';
    if (end - start > 24 * 60 * 60 * 1000) return '单次诊断时间窗最多 24 小时';
    return null;
  }, [window]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!equipmentId) {
      setFormError('请选择设备');
      return;
    }
    if (windowError) {
      setFormError(windowError);
      return;
    }
    setSubmitting(true);
    try {
      const result = await diagnosisApi.createRun({
        workspace_id: workspaceId,
        alarm_id: alarmId || undefined,
        equipment_id: equipmentId,
        window: {
          start: toUtcIso(window.start),
          end: toUtcIso(window.end),
        },
        symptom: symptom.trim(),
      });
      navigate(`/runs/${result.run.id}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '无法创建诊断任务');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="diag-fade-up">
      <PageHeader
        title="发起诊断"
        description="选择设备与时间窗。诊断会自动执行五个阶段，所有工具调用受只读策略与预算约束。"
      />

      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="diag-card p-5">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <label
                htmlFor="equipment"
                className="flex items-center gap-1.5 text-xs font-medium text-gray-700"
              >
                <Cpu className="size-3.5 text-gray-400" />
                设备
              </label>
              <select
                id="equipment"
                value={equipmentId}
                onChange={(event) => {
                  setEquipmentId(event.target.value);
                  setAlarmId('');
                  setWindow(defaultWindow(null));
                  setSymptom('');
                }}
                className="h-9 w-full rounded-lg border border-gray-200 bg-white px-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                disabled={loading}
                required
              >
                {equipment.length === 0 ? (
                  <option value="">暂无设备</option>
                ) : null}
                {equipment.map((item) => (
                  <option key={item.equipment_id} value={item.equipment_id}>
                    {item.name} · {item.vendor} {item.model} · {item.serial}
                  </option>
                ))}
              </select>
            </div>

            {selectedEquipment ? (
              <div className="rounded-lg border border-gray-100 bg-gray-50/70 p-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
                  <span className="diag-code text-gray-600">
                    {selectedEquipment.equipment_id}
                  </span>
                  <span>{selectedEquipment.asset_category}</span>
                  {selectedEquipment.manual_version ? (
                    <span>手册版本 {selectedEquipment.manual_version}</span>
                  ) : (
                    <span className="text-amber-700">未登记主手册版本</span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(selectedEquipment.metrics).map(
                    ([metric, info]) => (
                      <span
                        key={metric}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-600"
                      >
                        <Gauge className="size-2.5 text-gray-400" />
                        {metric}
                        <span className="text-gray-400">
                          {info.unit} · {info.normal_range[0]}~
                          {info.normal_range[1]}
                        </span>
                      </span>
                    ),
                  )}
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label
                htmlFor="alarm"
                className="flex items-center gap-1.5 text-xs font-medium text-gray-700"
              >
                <BellRing className="size-3.5 text-gray-400" />
                关联报警
                <span className="font-normal text-gray-400">（可选）</span>
              </label>
              <select
                id="alarm"
                value={alarmId}
                onChange={(event) => setAlarmId(event.target.value)}
                className="h-9 w-full rounded-lg border border-gray-200 bg-white px-2.5 text-sm text-gray-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              >
                <option value="">不关联报警（按症状诊断）</option>
                {equipmentAlarms.map((alarm) => (
                  <option key={alarm.id} value={alarm.id}>
                    {alarm.code} · {alarm.message.slice(0, 40)} ·{' '}
                    {formatTime(alarm.raised_at)}
                  </option>
                ))}
              </select>
              {queryAlarmId && !selectedAlarm && !loading ? (
                <div className="text-[11px] text-amber-700">
                  未在活动报警中找到该报警，可能已清除；将以所选设备与时间窗继续。
                </div>
              ) : null}
              {selectedAlarm ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-blue-100 bg-blue-50/60 px-2.5 py-2 text-[11px] text-gray-600">
                  <SeverityBadge severity={selectedAlarm.severity} />
                  <span className="diag-code text-gray-500">
                    {selectedAlarm.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {selectedAlarm.message}
                  </span>
                  <span className="text-gray-400">
                    {formatTime(selectedAlarm.raised_at)}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="window-start"
                  className="flex items-center gap-1.5 text-xs font-medium text-gray-700"
                >
                  <Clock3 className="size-3.5 text-gray-400" />
                  开始时间
                </label>
                <Input
                  id="window-start"
                  type="datetime-local"
                  value={window.start}
                  onChange={(event) =>
                    setWindow((current) => ({
                      ...current,
                      start: event.target.value,
                    }))
                  }
                  className="h-9 bg-white"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="window-end"
                  className="text-xs font-medium text-gray-700"
                >
                  结束时间
                </label>
                <Input
                  id="window-end"
                  type="datetime-local"
                  value={window.end}
                  onChange={(event) =>
                    setWindow((current) => ({
                      ...current,
                      end: event.target.value,
                    }))
                  }
                  className="h-9 bg-white"
                  required
                />
              </div>
            </div>
            {windowError ? (
              <div className="text-[11px] text-amber-700">{windowError}</div>
            ) : (
              <div className="text-[11px] text-gray-400">
                时间窗按浏览器本地时间输入，提交时转换为 UTC。单次最多 24 小时。
              </div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="symptom"
                className="text-xs font-medium text-gray-700"
              >
                现场症状 / 诊断目标
              </label>
              <Textarea
                id="symptom"
                value={symptom}
                onChange={(event) => setSymptom(event.target.value)}
                placeholder="例如：3 号风机轴承温度持续偏高，伴随振动上升，请判断是否为轴承磨损。"
                className="min-h-24 bg-white"
                maxLength={2000}
              />
              <div className="text-right text-[10px] text-gray-400">
                {symptom.length}/2000
              </div>
            </div>

            {formError ? (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700"
              >
                {formError}
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
              <div className="text-[11px] leading-5 text-gray-400">
                诊断工具只读；控制类建议需人工审批且本版本不执行。
              </div>
              <Button
                type="submit"
                className="bg-blue-600 text-white hover:bg-blue-700"
                disabled={submitting || loading || equipment.length === 0}
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {submitting ? '正在创建…' : '开始诊断'}
                {!submitting ? <ArrowRight className="size-3.5" /> : null}
              </Button>
            </div>
          </form>
        </Card>

        <div className="space-y-4">
          <Card className="diag-card p-4">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-900">
              <FileSearch className="size-3.5 text-blue-600" />
              诊断会做什么
            </div>
            <ol className="mt-3 space-y-3">
              {STAGES.map((stage, index) => (
                <li key={stage.name} className="flex gap-2.5">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-blue-100 bg-blue-50 text-[10px] font-semibold text-blue-700">
                    {index + 1}
                  </span>
                  <div>
                    <div className="text-xs font-medium text-gray-800">
                      {stage.name}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-5 text-gray-500">
                      {stage.text}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          <Card className="diag-card p-4">
            <div className="text-xs font-semibold text-gray-900">运行预算</div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
              {[
                ['总轮次', '8'],
                ['每阶段轮次', '3'],
                ['工具调用', '32'],
                ['模型调用', '16'],
                ['单源超时', '10s'],
                ['总时长', '300s'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between">
                  <dt className="text-gray-400">{label}</dt>
                  <dd className="font-medium text-gray-700">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 border-t border-gray-100 pt-2 text-[10px] leading-4 text-gray-400">
              超出预算会停止并保留已获证据；重复查询会复用缓存或被拒绝。
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
