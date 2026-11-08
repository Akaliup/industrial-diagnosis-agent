import type {
  AlarmContext,
  EquipmentSnapshot,
  Evidence,
  RootCauseCode,
} from './contracts/domain.js';

export interface SeriesSummary {
  evidenceId: string;
  metric: string;
  unit: string;
  points: Array<{ t: string; v: number; q: string }>;
  first: number;
  last: number;
  delta: number;
  min: number;
  max: number;
  avg: number;
  missing: number;
  unique: number;
  std: number;
  spikeCount: number;
}

export interface ManualFact {
  evidenceId: string;
  documentId: string;
  model: string;
  version: string;
  section: string | null;
  page: number;
  excerpt: string;
  text: string;
}

export interface Findings {
  hasTelemetry: boolean;
  hasStatus: boolean;
  series: Map<string, SeriesSummary>;
  alarms: Array<{
    evidenceId: string;
    code: string;
    severity: string;
    state: 'active' | 'cleared' | 'unknown';
    raisedAt: string;
    clearedAt: string | null;
    message: string;
  }>;
  mesEvents: Array<{
    evidenceId: string;
    eventId: string;
    eventType: string;
    occurredAt: string;
    summary: string;
  }>;
  workOrders: Array<{
    evidenceId: string;
    workOrderId: string;
    status: string;
    rootCauseCode: string | null;
    title: string;
  }>;
  manuals: ManualFact[];
  cases: Array<{
    evidenceId: string;
    caseId: string;
    rootCauseCode: string;
    title: string;
    model: string;
  }>;
  missingSamples: number;
  clockSkew: boolean;
  manualVersionConflict: boolean;
  manualMissing: boolean;
  manualPrimaryMissing: boolean;
  manualRegistrationMissing: boolean;
  sourceFailures: string[];
  allMetricsNormal: boolean;
}

export const NORMAL_RANGES: Record<
  string,
  Record<string, { unit: string; min: number; max: number }>
> = {
  'NP-200': {
    bearing_temperature: { unit: '°C', min: 40, max: 80 },
    vibration_rms: { unit: 'mm/s', min: 0, max: 4.5 },
    discharge_pressure: { unit: 'MPa', min: 0.5, max: 0.75 },
    flow_rate: { unit: 'm3/h', min: 90, max: 140 },
    motor_current: { unit: 'A', min: 35, max: 60 },
  },
  'NP-300': {
    bearing_temperature: { unit: '°C', min: 40, max: 85 },
    vibration_rms: { unit: 'mm/s', min: 0, max: 3.5 },
    discharge_pressure: { unit: 'MPa', min: 0.7, max: 1.0 },
    flow_rate: { unit: 'm3/h', min: 150, max: 210 },
    motor_current: { unit: 'A', min: 60, max: 90 },
    motor_winding_temperature: { unit: '°C', min: 50, max: 110 },
  },
};

export function manualMetric(metric: string): string | null {
  if (metric === 'bearing_temperature') return 'temperature';
  if (metric === 'vibration_rms') return 'vibration';
  return null;
}

export function summarizeSeries(evidence: Evidence): SeriesSummary | null {
  if (evidence.payload.kind !== 'telemetry_series') return null;
  const payload = evidence.payload;
  const sorted = [...payload.points].sort(
    (a, b) => Date.parse(a.t) - Date.parse(b.t),
  );
  // missing 点可能携带占位值或陈旧值，不能参与数值统计；否则会把
  // 占位值当成真实读数，产生虚假的越界/尖峰特征。缺失数量仍单独统计。
  const values = sorted.filter((p) => p.q !== 'missing').map((p) => p.v);
  if (values.length === 0) return null;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  // 用首尾线性趋势的残差识别尖峰；直接对全局中位数取偏差会把
  // 单调温升的端点误判为尖峰。
  const spikeThreshold = payload.metric === 'vibration_rms' ? 1.2 : 10;
  const first = values[0];
  const last = values[values.length - 1];
  const spikeCount = values.filter((value, index) => {
    if (values.length <= 2) return false;
    const trend =
      first + ((last - first) * index) / Math.max(1, values.length - 1);
    return Math.abs(value - trend) > spikeThreshold;
  }).length;
  return {
    evidenceId: evidence.id,
    metric: payload.metric,
    unit: payload.unit,
    points: sorted,
    first,
    last,
    delta: last - first,
    min: Math.min(...values),
    max: Math.max(...values),
    avg,
    // 只统计明确的 missing 质量点；clock_skew / bad 等由独立 flag 表达，
    // 不能混入采样缺口，否则完整但时钟偏移的序列会被误判为 sampling_gap。
    missing: sorted.filter((p) => p.q === 'missing').length,
    unique: new Set(values.map((v) => v.toFixed(2))).size,
    std: Math.sqrt(variance),
    spikeCount,
  };
}

/**
 * 由遥测序列本身导出的可复核特征。只描述数据形态，不推断根因，
 * 供模型在“机械 / 传感器 / 数据路径”之间做显式比较。
 */
export interface TelemetryFeature {
  metric: string;
  unit: string;
  evidenceId: string;
  points: number;
  first: number;
  last: number;
  delta: number;
  min: number;
  max: number;
  avg: number;
  missing: number;
  unique: number;
  spikeCount: number;
  normalRange: { min: number; max: number; unit: string } | null;
  /** out_of_range / trend / spike / constant / range_limit / near_upper_limit / missing / clock_skew / quality */
  flags: string[];
  summary: string;
}

export interface AnomalyLedgerItem extends TelemetryFeature {
  referencedAsSupport: string[];
  referencedAsContradiction: string[];
  /** 没有任何 supported 诊断假设把它作为支持证据。 */
  unexplained: boolean;
}

const FEATURE_LABELS: Record<string, string> = {
  out_of_range: '越出正常范围',
  trend: '显著趋势',
  spike: '孤立尖峰',
  constant: '读数恒定',
  range_limit: '恒定在量程/物理边界',
  near_upper_limit: '接近上限',
  missing: '采样缺失',
  clock_skew: '时钟偏移',
  quality: '质量标记异常',
};

function round(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * 每个指标取样本最长的一条序列（同一指标可能因分页被多次入库）。
 * 该函数不读取评测 gold，也不依赖 case id。
 */
export function deriveTelemetryFeatures(
  evidence: Evidence[],
  equipmentModel: string,
): TelemetryFeature[] {
  const ranges = NORMAL_RANGES[equipmentModel] ?? {};
  const best = new Map<string, SeriesSummary>();
  for (const item of evidence) {
    const summary = summarizeSeries(item);
    if (!summary) continue;
    const existing = best.get(summary.metric);
    if (!existing || summary.points.length > existing.points.length) {
      best.set(summary.metric, summary);
    }
  }
  const features: TelemetryFeature[] = [];
  for (const summary of best.values()) {
    const range = ranges[summary.metric] ?? null;
    const flags: string[] = [];
    if (range) {
      if (summary.max > range.max || summary.min < range.min) {
        flags.push('out_of_range');
      }
      if (summary.max >= range.max * 0.95 && summary.max <= range.max) {
        flags.push('near_upper_limit');
      }
      if (
        summary.unique <= 1 &&
        summary.points.length >= 5 &&
        (summary.max >= range.max || summary.min <= range.min)
      ) {
        flags.push('range_limit');
      }
      const span = range.max - range.min;
      if (span > 0 && Math.abs(summary.delta) > span * 0.1) {
        flags.push('trend');
      }
    } else if (summary.points.length >= 5 && Math.abs(summary.delta) > 0) {
      const scale = Math.max(Math.abs(summary.avg), 1);
      if (Math.abs(summary.delta) > scale * 0.1) flags.push('trend');
    }
    if (summary.spikeCount > 0) flags.push('spike');
    if (summary.unique <= 1 && summary.points.length >= 5) {
      flags.push('constant');
    }
    if (summary.missing > 0) flags.push('missing');
    if (summary.points.some((point) => point.q === 'clock_skew')) {
      flags.push('clock_skew');
    }
    if (
      summary.points.some(
        (point) => point.q !== 'good' && point.q !== 'clock_skew',
      )
    ) {
      flags.push('quality');
    }
    const rangeText = range
      ? `正常范围 ${range.min}–${range.max}${range.unit}`
      : '无登记正常范围';
    features.push({
      metric: summary.metric,
      unit: summary.unit,
      evidenceId: summary.evidenceId,
      points: summary.points.length,
      first: round(summary.first),
      last: round(summary.last),
      delta: round(summary.delta),
      min: round(summary.min),
      max: round(summary.max),
      avg: round(summary.avg),
      missing: summary.missing,
      unique: summary.unique,
      spikeCount: summary.spikeCount,
      normalRange: range,
      flags,
      summary:
        `${summary.metric} 首 ${round(summary.first)}${summary.unit} → 末 ${round(summary.last)}${summary.unit}` +
        `（Δ${summary.delta >= 0 ? '+' : ''}${round(summary.delta)}），` +
        `min ${round(summary.min)} / max ${round(summary.max)} / avg ${round(summary.avg)}${summary.unit}，` +
        `${rangeText}，样本 ${summary.points.length}，缺失 ${summary.missing}，` +
        `不同读数 ${summary.unique}，尖峰 ${summary.spikeCount}` +
        (flags.length > 0
          ? `；标记：${flags.map((flag) => FEATURE_LABELS[flag] ?? flag).join('、')}`
          : ''),
    });
  }
  return features.sort((a, b) => a.metric.localeCompare(b.metric));
}

export function deriveAnomalyLedger(
  features: TelemetryFeature[],
  hypotheses: Array<{
    code: string;
    status: string;
    supporting_evidence_ids: string[];
    contradicting_evidence_ids: string[];
  }>,
): AnomalyLedgerItem[] {
  const ledger: AnomalyLedgerItem[] = [];
  for (const feature of features) {
    if (feature.flags.length === 0) continue;
    const referencedAsSupport = hypotheses
      .filter(
        (hypothesis) =>
          hypothesis.status === 'supported' &&
          hypothesis.code !== 'insufficient_evidence' &&
          hypothesis.code !== 'unknown' &&
          hypothesis.supporting_evidence_ids.includes(feature.evidenceId),
      )
      .map((hypothesis) => hypothesis.code);
    const referencedAsContradiction = hypotheses
      .filter((hypothesis) =>
        hypothesis.contradicting_evidence_ids.includes(feature.evidenceId),
      )
      .map((hypothesis) => hypothesis.code);
    ledger.push({
      ...feature,
      referencedAsSupport: [...new Set(referencedAsSupport)],
      referencedAsContradiction: [...new Set(referencedAsContradiction)],
      unexplained: referencedAsSupport.length === 0,
    });
  }
  return ledger;
}

export function collectFindings(input: {
  evidence: Evidence[];
  equipment: EquipmentSnapshot;
  alarm: AlarmContext | null;
  toolHistory: Array<{ status: string; error_code: string | null }>;
}): Findings {
  const series = new Map<string, SeriesSummary>();
  const alarms: Findings['alarms'] = [];
  const mesEvents: Findings['mesEvents'] = [];
  const workOrders: Findings['workOrders'] = [];
  const manuals: ManualFact[] = [];
  const cases: Findings['cases'] = [];
  let hasStatus = false;
  let clockSkew = false;

  for (const evidence of input.evidence) {
    const p = evidence.payload;
    if (p.kind === 'telemetry_series') {
      const summary = summarizeSeries(evidence);
      if (summary) {
        const existing = series.get(p.metric);
        if (!existing || summary.points.length > existing.points.length) {
          series.set(p.metric, summary);
        }
        if (summary.points.some((point) => point.q === 'clock_skew')) {
          clockSkew = true;
        }
      }
    } else if (p.kind === 'status_snapshot') {
      hasStatus = true;
      if (p.points.some((point) => point.quality === 'clock_skew')) {
        clockSkew = true;
      }
    } else if (p.kind === 'alarm') {
      alarms.push({
        evidenceId: evidence.id,
        code: p.code,
        severity: p.severity,
        state: p.state,
        raisedAt: p.raised_at,
        clearedAt: p.cleared_at,
        message: p.message,
      });
    } else if (p.kind === 'mes_event') {
      mesEvents.push({
        evidenceId: evidence.id,
        eventId: p.event_id,
        eventType: p.event_type,
        occurredAt: p.occurred_at,
        summary: p.summary,
      });
      if (p.event_type === 'clock_sync' || /时钟|NTP|clock/i.test(p.summary)) {
        clockSkew = true;
      }
    } else if (p.kind === 'work_order') {
      workOrders.push({
        evidenceId: evidence.id,
        workOrderId: p.work_order_id,
        status: p.status,
        rootCauseCode: p.root_cause_code,
        title: p.title,
      });
    } else if (p.kind === 'manual_chunk') {
      manuals.push({
        evidenceId: evidence.id,
        documentId: p.document_id,
        model: p.model,
        version: p.manual_version,
        section: p.section,
        page: p.pdf_page_index,
        excerpt: p.excerpt,
        text: p.excerpt,
      });
    } else if (p.kind === 'case_record') {
      cases.push({
        evidenceId: evidence.id,
        caseId: p.case_id,
        rootCauseCode: p.root_cause_code,
        title: p.title,
        model: p.equipment_model,
      });
    }
  }

  const missingSamples = [...series.values()].reduce(
    (sum, item) => sum + item.missing,
    0,
  );
  // 适用版本以设备台账登记为准；没有登记时不能按机型猜一个版本来下结论。
  const expectedVersion = input.equipment.manual_version ?? null;
  const manualRegistrationMissing =
    !input.equipment.manual_version || !input.equipment.manual_document_id;
  const manualVersionConflict =
    expectedVersion !== null &&
    manuals.length > 0 &&
    manuals.every((manual) => manual.version !== expectedVersion);
  const manualMissing = manuals.length === 0;
  const primaryManualDocument = input.equipment.manual_document_id ?? null;
  const manualPrimaryMissing =
    primaryManualDocument !== null &&
    manuals.length > 0 &&
    !manuals.some((manual) => manual.documentId === primaryManualDocument);
  const sourceFailures = [
    ...new Set(
      input.toolHistory
        .map((item) => item.error_code)
        .filter((code): code is string => Boolean(code)),
    ),
  ];
  const ranges = NORMAL_RANGES[input.equipment.model] ?? {};
  let allMetricsNormal = true;
  for (const [metric, summary] of series) {
    const range = ranges[metric];
    if (!range) continue;
    if (
      summary.max > range.max * 1.05 ||
      summary.min < range.min - Math.max(1, range.max * 0.05)
    ) {
      allMetricsNormal = false;
    }
  }
  if (series.size === 0) allMetricsNormal = false;

  return {
    hasTelemetry: series.size > 0,
    hasStatus,
    series,
    alarms,
    mesEvents,
    workOrders,
    manuals,
    cases,
    missingSamples,
    clockSkew,
    manualVersionConflict,
    manualMissing,
    manualPrimaryMissing,
    manualRegistrationMissing,
    sourceFailures,
    allMetricsNormal,
  };
}

export interface Inference {
  codes: RootCauseCode[];
  primary: RootCauseCode;
  handoff: boolean;
  handoffReason: string | null;
  notes: string[];
}

function hasSourceFailure(findings: Findings, codes: string[]): boolean {
  return findings.sourceFailures.some((code) => codes.includes(code));
}

function normalRange(
  model: string,
  metric: string,
): { min: number; max: number } {
  return (
    NORMAL_RANGES[model]?.[metric] ?? {
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
    }
  );
}

/**
 * 基于可观测数据的确定性根因推断，仅用于 FixtureRoleRunner 演示。
 * 不读取评测 gold；所有判断来自遥测形态、报警、MES 与手册证据。
 */
export function inferRootCauses(input: {
  findings: Findings;
  equipment: EquipmentSnapshot;
  alarm: AlarmContext | null;
  symptom: string | null;
  controlIntent: boolean;
}): Inference {
  const { findings, equipment, alarm, symptom } = input;
  const temp = findings.series.get('bearing_temperature');
  const vibration = findings.series.get('vibration_rms');
  const current = findings.series.get('motor_current');
  const notes: string[] = [];
  const tempDelta = temp?.delta ?? 0;
  const vibDelta = vibration?.delta ?? 0;
  const currentDelta = current?.delta ?? 0;
  const alarmText = `${alarm?.code ?? ''} ${alarm?.message ?? ''} ${findings.alarms
    .map((item) => `${item.code} ${item.message}`)
    .join(' ')}`;
  const commAlarm = /COMM|通讯|通信|总线/i.test(alarmText);
  const thresholdAlarm = /THR|阈值|threshold/i.test(alarmText);
  const cleared = findings.alarms.some((item) => item.state === 'cleared');
  const mesNetwork = findings.mesEvents.some(
    (event) =>
      event.eventType === 'network_maintenance' ||
      /网络|通讯|断连|gateway/i.test(event.summary),
  );
  const mesClock = findings.mesEvents.some(
    (event) =>
      event.eventType === 'clock_sync' || /时钟|NTP|clock/i.test(event.summary),
  );
  const tempRange = normalRange(equipment.model, 'bearing_temperature');
  const vibrationRange = normalRange(equipment.model, 'vibration_rms');
  const currentVersion = equipment.manual_version ?? null;
  const currentManuals = currentVersion
    ? findings.manuals.filter((manual) => manual.version === currentVersion)
    : [];
  // 未登记版本时不回退到“任意版本”的手册，避免用错误版本推断阈值。
  const manualPool = currentManuals;
  const manualTempThreshold = manualPool.find((manual) =>
    manual.section?.startsWith('5.2'),
  );
  const manualThreshold =
    Number(
      manualTempThreshold?.text.match(/(\d{2,3})\s*(?:°?C|C)/)?.[1] ?? NaN,
    ) || tempRange.max;
  const manualVibrationLimit =
    Number(
      manualPool
        .find((manual) => manual.section?.startsWith('6.1'))
        ?.text.match(/(\d+(?:\.\d+)?)\s*mm\/s/)?.[1] ?? NaN,
    ) || vibrationRange.max;
  void manualVibrationLimit;

  const stuck =
    Boolean(temp) &&
    temp!.unique <= 3 &&
    temp!.points.filter((point) => point.q === 'good').length >= 10;
  const outOfRange = Boolean(temp) && temp!.max > tempRange.max * 2.5;
  const gap = findings.missingSamples >= 5;
  const tempRise = tempDelta >= 8;
  const tempRiseBig = tempDelta >= 15;
  const vibRise = vibDelta >= 2.5;
  const currentRise = currentDelta >= 2.5;
  const spikes = (temp?.spikeCount ?? 0) >= 2;

  if (temp)
    notes.push(`温度 ${temp.first}→${temp.last}（Δ${tempDelta.toFixed(1)}）`);
  if (vibration) {
    notes.push(
      `振动 ${vibration.first}→${vibration.last}（Δ${vibDelta.toFixed(1)}）`,
    );
  }
  if (current)
    notes.push(
      `电流 ${current.first}→${current.last}（Δ${currentDelta.toFixed(1)}）`,
    );
  if (gap) notes.push(`缺失样本 ${findings.missingSamples}`);
  if (findings.clockSkew) notes.push('存在时钟偏移/乱序');

  const insufficientBase =
    (!findings.hasTelemetry &&
      (hasSourceFailure(findings, [
        'TIMEOUT',
        'UNCONFIGURED',
        'SOURCE_UNAVAILABLE',
      ]) ||
        findings.alarms.length === 0)) ||
    (hasSourceFailure(findings, ['UNCONFIGURED']) && !findings.hasTelemetry);

  if (insufficientBase) {
    return {
      codes: ['insufficient_evidence'],
      primary: 'insufficient_evidence',
      handoff: true,
      handoffReason:
        '关键实时来源不可用或没有可核查的遥测证据，无法确认报警时设备状态。',
      notes,
    };
  }

  if (!equipment.manual_document_id || !equipment.manual_version) {
    return {
      codes: ['insufficient_evidence'],
      primary: 'insufficient_evidence',
      handoff: true,
      handoffReason:
        '设备台账未登记适用手册与版本，无法确认判定阈值与维修条款；需要工程师确认有效手册后再下结论。',
      notes: [...notes, '设备未登记适用手册，已阻止形成确定根因'],
    };
  }

  if (input.controlIntent) {
    const base = inferRootCauses({
      ...input,
      controlIntent: false,
      symptom: null,
    });
    return {
      ...base,
      handoff: true,
      handoffReason: CONTROL_INTENT_HANDOFF_REASON,
      notes: [...base.notes, '检测到控制意图，已拒绝执行'],
    };
  }

  if (findings.manualRegistrationMissing) {
    return {
      codes: ['insufficient_evidence'],
      primary: 'insufficient_evidence',
      handoff: true,
      handoffReason:
        '设备台账未登记适用的手册文档/版本，无法确认当前阈值与判定条款；需要工程师确认有效手册后再下结论。',
      notes: [...notes, '手册登记缺失，不能按机型猜测版本'],
    };
  }

  if (findings.manualPrimaryMissing) {
    return {
      codes: ['insufficient_evidence'],
      primary: 'insufficient_evidence',
      handoff: true,
      handoffReason:
        '设备适用的主手册不可用或已撤版，无法确认当前阈值与判定条款；需要工程师确认有效手册后再下结论。',
      notes: [...notes, '主手册缺失，不能形成确定根因'],
    };
  }

  if (
    findings.manualVersionConflict &&
    (vibRise || tempRise || stuck || outOfRange || gap)
  ) {
    return {
      codes: ['insufficient_evidence'],
      primary: 'insufficient_evidence',
      handoff: true,
      handoffReason:
        '可用手册版本与设备不匹配，无法确认当前阈值与判定条款；需要工程师确认适用手册后再下结论。',
      notes: [...notes, '手册版本冲突，已阻止把遥测异常升级为确定根因'],
    };
  }

  // 假报警优先：先判断“报警本身是否可信”，避免把数据链路问题写成机械故障。
  if (thresholdAlarm && temp && temp.max < manualThreshold && tempRise) {
    return {
      codes: ['false_alarm_threshold'],
      primary: 'false_alarm_threshold',
      handoff: false,
      handoffReason: null,
      notes: [
        ...notes,
        `报警阈值与手册不一致：最高 ${temp.max}°C < 当前手册阈值 ${manualThreshold}°C`,
      ],
    };
  }
  if (commAlarm || mesNetwork) {
    if (vibRise) {
      return {
        codes: ['bearing_wear', 'false_alarm_comm'],
        primary: 'bearing_wear',
        handoff: false,
        handoffReason: null,
        notes: [...notes, '通讯链路异常与振动劣化同时存在'],
      };
    }
    return {
      codes: ['false_alarm_comm'],
      primary: 'false_alarm_comm',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '通讯/采样链路异常，工艺值正常'],
    };
  }
  if ((mesClock || findings.clockSkew) && !vibRise) {
    return {
      codes: ['false_alarm_time'],
      primary: 'false_alarm_time',
      handoff: false,
      handoffReason: null,
      notes: [...notes, 'MES 记录时钟偏移，报警时间戳不可信'],
    };
  }
  if (cleared && findings.allMetricsNormal) {
    return {
      codes: ['false_alarm_recovered'],
      primary: 'false_alarm_recovered',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '报警已恢复且当前工艺值正常'],
    };
  }

  if (stuck && vibRise) {
    return {
      codes: ['sensor_stuck', 'bearing_wear'],
      primary: 'bearing_wear',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '温度测点卡值，但振动趋势仍反映机械劣化'],
    };
  }
  if (spikes && vibRise && tempDelta >= 3) {
    return {
      codes: ['bearing_wear', 'sensor_drift'],
      primary: 'bearing_wear',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '温度存在与负荷不符的尖峰，同时振动持续上升'],
    };
  }
  if (vibRise && tempDelta >= 5 && tempDelta < 12 && currentRise) {
    return {
      codes: ['misalignment', 'lubrication'],
      primary: 'misalignment',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '振动与电流上升、温升中等，符合不对中合并润滑不良'],
    };
  }
  if (outOfRange) {
    return {
      codes: ['sensor_range'],
      primary: 'sensor_range',
      handoff: false,
      handoffReason: null,
      notes: [...notes, `温度 ${temp!.max}°C 超出量程`],
    };
  }
  if (stuck) {
    return {
      codes: ['sensor_stuck'],
      primary: 'sensor_stuck',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '温度读数长时间完全不变'],
    };
  }
  if (tempRiseBig && vibRise && currentRise) {
    return {
      codes: ['bearing_wear'],
      primary: 'bearing_wear',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '温升、振动与电流同步上升'],
    };
  }
  if (tempRise && !vibRise && !currentRise) {
    if (findings.manualVersionConflict) {
      return {
        codes: ['sensor_drift', 'insufficient_evidence'],
        primary: 'insufficient_evidence',
        handoff: true,
        handoffReason:
          '手册版本与设备不匹配，无法确认当前漂移判定阈值；需要工程师确认适用手册。',
        notes: [...notes, '手册版本冲突，漂移结论不能升级为确定结论'],
      };
    }
    return {
      codes: ['sensor_drift'],
      primary: 'sensor_drift',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '温度上升而振动、电流稳定，符合传感器漂移特征'],
    };
  }
  if (vibRise && tempDelta < 8) {
    return {
      codes: ['misalignment'],
      primary: 'misalignment',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '振动明显上升而温升有限，优先怀疑不对中'],
    };
  }
  if (vibRise && tempDelta >= 5 && !currentRise) {
    return {
      codes: ['lubrication'],
      primary: 'lubrication',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '振动与温度中度上升、电流稳定，符合润滑不良'],
    };
  }
  if (gap) {
    return {
      codes: ['sampling_gap'],
      primary: 'sampling_gap',
      handoff: false,
      handoffReason: null,
      notes: [...notes, '采样缺口需要补齐后再判断趋势'],
    };
  }
  if (findings.hasTelemetry) {
    return {
      codes: ['unknown'],
      primary: 'unknown',
      handoff: true,
      handoffReason: '现有证据不足以形成可核查的根因假设，转人工补充现场检查。',
      notes,
    };
  }
  return {
    codes: ['insufficient_evidence'],
    primary: 'insufficient_evidence',
    handoff: true,
    handoffReason: '没有可用的遥测证据。',
    notes,
  };
}

export const CONTROL_INTENT_HANDOFF_REASON =
  '请求包含设备控制/复位意图；本版只提供只读诊断，控制必须由工程师按规程现场执行。';

export function detectControlIntent(
  symptom: string | null | undefined,
): boolean {
  if (!symptom) return false;
  return /复位|重启|启动|停机|关闭|打开|调整|设定|写入|下发|控制|remote start|reset|stop/i.test(
    symptom,
  );
}
