import {
  type AlarmContext,
  type Check,
  type DataInvestigatorOutput,
  type EquipmentSnapshot,
  type Evidence,
  type Hypothesis,
  type HypothesisDraft,
  type HypothesisVerifierOutput,
  type KnowledgeRetrieverOutput,
  type Observation,
  type QueryRequest,
  type Recommendation,
  type ReportDraft,
  type ReportReviewerOutput,
  type Role,
  type RootCauseCode,
  type Run,
  type Stage,
} from './contracts/domain.js';
import {
  collectFindings,
  detectControlIntent,
  expectedManualVersion,
  inferRootCauses,
  NORMAL_RANGES,
  type Findings,
  type Inference,
} from './analysis.js';
import type {
  RoleCallInput,
  RoleCallResult,
  RoleRunner,
} from './role-runner.js';
import { estimateRoleTokens } from './role-runner.js';

function query(
  tool: QueryRequest['tool'],
  args: Record<string, unknown>,
  target: string | null,
  gap: string,
  discrimination: string,
  rationale: string,
): QueryRequest {
  return {
    tool,
    args,
    target_hypothesis: target,
    evidence_gap: gap,
    expected_discrimination: discrimination,
    rationale,
  };
}

function metricsFor(model: string): string[] {
  return Object.keys(NORMAL_RANGES[model] ?? {});
}

function telemetryArgs(
  run: Run,
  equipment: EquipmentSnapshot,
): Record<string, unknown> {
  return {
    equipment_id: equipment.equipment_id,
    query_kind: 'telemetry',
    window: run.window,
    metrics: metricsFor(equipment.model),
    limit: 1000,
  };
}

function evidenceIds(
  evidence: Evidence[],
  predicate: (evidence: Evidence) => boolean,
  limit = 12,
): string[] {
  return evidence
    .filter(predicate)
    .map((item) => item.id)
    .slice(0, limit);
}

function manualIds(findings: Findings, prefix: string): string[] {
  return findings.manuals
    .filter((manual) => manual.section?.startsWith(prefix))
    .map((manual) => manual.evidenceId)
    .slice(0, 3);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function describeEvidence(evidence: Evidence): string | null {
  const p = evidence.payload;
  switch (p.kind) {
    case 'status_snapshot':
      return `设备 ${p.equipment_id} 状态 ${p.state}，最后上报 ${p.last_seen ?? '未知'}。`;
    case 'telemetry_series': {
      const first = p.points[0]?.v;
      const last = p.points[p.points.length - 1]?.v;
      const delta =
        typeof first === 'number' && typeof last === 'number'
          ? (last - first).toFixed(2)
          : '未知';
      return `${p.metric} 从 ${first ?? '未知'}${p.unit} 变化到 ${last ?? '未知'}${p.unit}（Δ${delta}），缺失 ${p.stats.missing} 点。`;
    }
    case 'alarm':
      return `报警 ${p.code}（${p.severity}，${p.state}）：${p.message}。`;
    case 'mes_event':
      return `MES ${p.event_type}：${p.summary}。`;
    case 'work_order':
      return `工单 ${p.work_order_id}（${p.status}）：${p.title}。`;
    case 'manual_chunk':
      return `手册 ${p.document_id} ${p.model} ${p.manual_version} 第 ${p.pdf_page_index} 页：${p.excerpt.slice(0, 120)}。`;
    case 'case_record':
      return `历史案例 ${p.case_id}：${p.title}；根因码 ${p.root_cause_code}。`;
    case 'telemetry_point':
      return `${p.metric}=${p.value}${p.unit}（${p.quality}）。`;
  }
}

function templateFor(code: RootCauseCode): {
  check: Omit<Check, 'id' | 'evidence_ids'>;
  recommendation: Omit<Recommendation, 'id' | 'evidence_ids'>;
} {
  switch (code) {
    case 'sensor_drift':
      return {
        check: {
          purpose: '用独立手持测温仪与在线温度对比，确认是否为传感器漂移',
          preconditions: ['现场允许近距离测温', '设备处于稳定负荷'],
          steps: [
            '记录在线温度',
            '在同一测点用校准过的测温仪测量',
            '计算偏差并记录环境温度',
          ],
          expected_observation:
            '偏差超过 5°C 支持传感器漂移；偏差很小则需重新评估机械因素',
          risk: 'low',
          role: '仪表/点检工程师',
          requires_human: true,
        },
        recommendation: {
          text: '安排仪表工程师对比测温；确认漂移后更换温度传感器，不据此更换轴承。',
          conditions: ['完成手持测温对比', '偏差超过 5°C'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'sensor_stuck':
      return {
        check: {
          purpose: '确认温度测点是否卡在固定值',
          preconditions: ['可读取原始采集值'],
          steps: [
            '检查传感器供电与信号回路',
            '对比相邻测点',
            '轻触检查是否有变化',
          ],
          expected_observation:
            '数值长时间完全不变且相邻测点正常，支持测点卡死',
          risk: 'low',
          role: '仪表工程师',
          requires_human: true,
        },
        recommendation: {
          text: '检查温度传感器与采集通道，必要时更换测点；机械结论需等待有效温度数据。',
          conditions: ['确认测点卡死'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'sensor_range':
      return {
        check: {
          purpose: '核对温度读数是否超出传感器量程',
          preconditions: ['可查看原始值'],
          steps: ['核对量程配置', '检查信号饱和', '与相邻测点对比'],
          expected_observation: '读数接近或超过量程上限，支持量程/配置问题',
          risk: 'low',
          role: '仪表工程师',
          requires_human: true,
        },
        recommendation: {
          text: '检查传感器量程与采集配置，修复前不要把该读数用于机械判断。',
          conditions: ['确认超量程'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'sampling_gap':
      return {
        check: {
          purpose: '确认采样缺口的时间范围与影响',
          preconditions: ['可访问采集网关日志'],
          steps: ['核对缺失时间窗', '检查网关与网络日志', '补齐数据后复算趋势'],
          expected_observation: '缺口与网络/网关事件吻合，补齐后趋势可判定',
          risk: 'low',
          role: '自动化工程师',
          requires_human: true,
        },
        recommendation: {
          text: '先修复采集链路并补齐数据，再判断是否存在机械异常。',
          conditions: ['采样恢复'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'bearing_wear':
      return {
        check: {
          purpose: '用振动频谱与油液分析确认轴承磨损',
          preconditions: ['设备可继续短时运行', '具备测振与取样条件'],
          steps: ['采集振动频谱', '检查轴承特征频率', '取样做油液分析'],
          expected_observation:
            '轴承特征频率能量上升、油液金属颗粒增加支持轴承磨损',
          risk: 'medium',
          role: '机械工程师',
          requires_human: true,
        },
        recommendation: {
          text: '安排机械工程师复核振动频谱与油液；根据结果计划停机更换轴承，当前不执行在线控制。',
          conditions: ['振动趋势持续恶化', '频谱或油液支持轴承磨损'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'misalignment':
      return {
        check: {
          purpose: '检查联轴器对中状态',
          preconditions: ['具备停机条件'],
          steps: ['激光对中测量', '检查联轴器与地脚', '复核热态补偿'],
          expected_observation: '径向/轴向偏差超差支持不对中',
          risk: 'medium',
          role: '机械工程师',
          requires_human: true,
        },
        recommendation: {
          text: '安排停机窗口做激光对中与联轴器检查；不要在运行中调整。',
          conditions: ['获得停机许可'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'lubrication':
      return {
        check: {
          purpose: '确认润滑状态',
          preconditions: ['可检查油位与油质'],
          steps: ['检查油位', '取样观察油质', '核对润滑周期'],
          expected_observation: '油位不足、油质劣化或润滑周期超期支持润滑不良',
          risk: 'low',
          role: '机械/润滑工程师',
          requires_human: true,
        },
        recommendation: {
          text: '按规程补油或换油，并复查振动与温度趋势。',
          conditions: ['确认润滑不良'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'false_alarm_comm':
      return {
        check: {
          purpose: '核对通讯链路与采集网关',
          preconditions: ['可访问网关与交换机日志'],
          steps: ['检查网关电源与网络', '核对断连时间', '与 MES 维护记录比对'],
          expected_observation:
            '断连时间与报警时间吻合，工艺值正常，支持通讯假报警',
          risk: 'low',
          role: '自动化工程师',
          requires_human: true,
        },
        recommendation: {
          text: '修复采集网关/网络链路并观察；不要因通讯报警更换机械部件。',
          conditions: ['通讯恢复'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'false_alarm_time':
      return {
        check: {
          purpose: '核对报警网关时钟与时间戳',
          preconditions: ['可查看报警网关与 NTP 记录'],
          steps: [
            '比对网关时间与标准时间',
            '检查 NTP 同步记录',
            '复算报警与趋势时间关系',
          ],
          expected_observation: '时钟偏移与报警时间差吻合，支持时间戳异常',
          risk: 'low',
          role: '自动化工程师',
          requires_human: true,
        },
        recommendation: {
          text: '校正报警网关时钟并复核报警时间；不要按错误时间戳安排检修。',
          conditions: ['时钟恢复同步'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'false_alarm_threshold':
      return {
        check: {
          purpose: '核对报警阈值配置与当前手册版本',
          preconditions: ['可查看报警组态', '有适用版本手册'],
          steps: [
            '读取当前阈值',
            '与手册 v2 条款比对',
            '检查是否仍引用旧版阈值',
          ],
          expected_observation: '组态阈值低于当前手册阈值，支持阈值配置假报警',
          risk: 'low',
          role: '自动化工程师',
          requires_human: true,
        },
        recommendation: {
          text: '按当前有效手册修正报警阈值配置，并保留变更记录。',
          conditions: ['确认阈值配置错误'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'false_alarm_recovered':
      return {
        check: {
          purpose: '确认报警已恢复且工艺参数稳定',
          preconditions: ['可查看趋势'],
          steps: ['复核报警恢复时间', '观察 30 分钟趋势', '确认无重复报警'],
          expected_observation: '报警恢复后参数稳定，支持短时假报警',
          risk: 'low',
          role: '运行工程师',
          requires_human: true,
        },
        recommendation: {
          text: '保持观察并记录；若重复出现再按通讯/阈值问题排查。',
          conditions: ['报警未重复'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'insufficient_evidence':
      return {
        check: {
          purpose: '补齐缺失的关键证据后再下结论',
          preconditions: ['明确缺失来源'],
          steps: ['恢复/配置只读来源', '确认适用手册版本', '补充现场检查记录'],
          expected_observation: '关键来源可用且证据齐全后重新诊断',
          risk: 'low',
          role: '诊断平台管理员/工程师',
          requires_human: true,
        },
        recommendation: {
          text: '当前证据不足，禁止据此安排更换或控制操作；先补齐数据与手册。',
          conditions: ['关键来源恢复', '手册版本确认'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
    case 'multi_fault':
    case 'unknown':
      return {
        check: {
          purpose: '人工复核多项异常并补充现场检查',
          preconditions: ['工程师到场'],
          steps: ['逐项核对证据', '补充现场检查', '确认根因组合'],
          expected_observation: '形成可核查的根因组合',
          risk: 'medium',
          role: '设备工程师',
          requires_human: true,
        },
        recommendation: {
          text: '转人工复核，不执行自动控制。',
          conditions: ['工程师确认'],
          requires_human: true,
          control_execution: 'disabled',
        },
      };
  }
}

export class FixtureRoleRunner implements RoleRunner {
  readonly mode = 'fixture' as const;
  readonly model = 'fixture-rule-runner-v1';

  async run(input: RoleCallInput): Promise<RoleCallResult> {
    const started = Date.now();
    let output: unknown;
    switch (input.role) {
      case 'data_investigator':
        output = this.investigate(input);
        break;
      case 'knowledge_retriever':
        output = this.retrieve(input);
        break;
      case 'hypothesis_verifier':
        output = this.verify(input);
        break;
      case 'report_reviewer':
        output = this.review(input);
        break;
    }
    const raw = JSON.stringify(output);
    const tokens = estimateRoleTokens(input, raw);
    return {
      output,
      mode: this.mode,
      model: this.model,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      latencyMs: Date.now() - started,
      raw,
    };
  }

  private findings(input: RoleCallInput): Findings {
    return collectFindings({
      evidence: input.evidence,
      equipment: input.equipment,
      alarm: input.alarm,
      toolHistory: input.toolHistory,
    });
  }

  private investigate(input: RoleCallInput): DataInvestigatorOutput {
    const { run, stage, equipment, stageRound } = input;
    const findings = this.findings(input);
    if (stageRound > 1) {
      return {
        summary: `证据已收集：遥测指标 ${findings.series.size} 个，报警 ${findings.alarms.length} 条，MES ${findings.mesEvents.length} 条，工单 ${findings.workOrders.length} 条。`,
        queries: [],
      };
    }
    const queries: QueryRequest[] = [];
    if (stage === 'confirm_status') {
      if (!findings.hasStatus) {
        queries.push(
          query(
            'equipment_query',
            {
              equipment_id: equipment.equipment_id,
              query_kind: 'status',
              window: run.window,
            },
            null,
            '缺少报警时段的设备状态快照',
            '确认设备是否运行、是否有活动报警',
            '状态快照是判断报警真实性的基础证据',
          ),
        );
      }
      if (!findings.hasTelemetry) {
        queries.push(
          query(
            'equipment_query',
            telemetryArgs(run, equipment),
            null,
            '缺少关键测点时间序列',
            '区分温度、振动、电流的不同变化形态',
            '趋势形态是传感器异常与机械故障的关键判别依据',
          ),
        );
      }
      if (findings.alarms.length === 0) {
        queries.push(
          query(
            'equipment_query',
            {
              equipment_id: equipment.equipment_id,
              query_kind: 'alarms',
              window: run.window,
              ...(input.alarm ? { alarm_code: input.alarm.code } : {}),
            },
            null,
            '缺少报警事件记录',
            '确认报警状态、触发与恢复时间',
            '报警记录用于区分活动报警、已恢复报警和时间戳异常',
          ),
        );
      }
    } else if (stage === 'locate_anomaly') {
      if (findings.mesEvents.length === 0) {
        queries.push(
          query(
            'equipment_query',
            {
              equipment_id: equipment.equipment_id,
              query_kind: 'mes_events',
              window: run.window,
            },
            null,
            '缺少 MES 运行与维护事件',
            '判断是否存在负荷变化、网络维护或时钟校正',
            'MES 事件能解释数据链路异常并避免误判机械故障',
          ),
        );
      }
      if (findings.workOrders.length === 0) {
        queries.push(
          query(
            'equipment_query',
            {
              equipment_id: equipment.equipment_id,
              query_kind: 'work_orders',
              window: run.window,
            },
            null,
            '缺少历史工单与根因记录',
            '判断是否为重复故障及既有处理措施',
            '工单记录提供历史维修背景',
          ),
        );
      }
      if (/重复调用|重复/.test(run.symptom ?? '') && findings.hasTelemetry) {
        queries.push(
          query(
            'equipment_query',
            telemetryArgs(run, equipment),
            null,
            '重复请求同一遥测以验证重复调用守卫',
            '相同参数应被拒绝或复用缓存，而不是重复消耗来源',
            '验证预算与重复调用保护',
          ),
        );
      }
    }
    return {
      summary:
        queries.length > 0
          ? `已发起 ${queries.length} 个只读查询，覆盖状态、趋势和上下文来源。`
          : '现有证据已覆盖本阶段所需的只读查询。',
      queries,
    };
  }

  private retrieve(input: RoleCallInput): KnowledgeRetrieverOutput {
    const { stage, equipment, stageRound } = input;
    const findings = this.findings(input);
    if (stage !== 'generate_hypotheses' || stageRound > 1) {
      return {
        summary: `已加载手册条款 ${findings.manuals.length} 条、历史案例 ${findings.cases.length} 条。`,
        queries: [],
      };
    }
    const queries: QueryRequest[] = [];
    if (findings.manuals.length === 0) {
      const version = expectedManualVersion(equipment.model);
      queries.push(
        query(
          'maintenance_search_manual',
          {
            query: '轴承 温度 振动 传感器 漂移 通讯 阈值',
            equipment_model: equipment.model,
            manual_version: version,
            limit: 8,
          },
          null,
          '缺少与当前设备型号和版本匹配的手册条款',
          '确认报警阈值、漂移判定与振动限值',
          '手册条款是确定建议和版本约束的依据',
        ),
      );
      queries.push(
        query(
          'maintenance_search_manual',
          {
            query: 'bearing temperature vibration sensor drift communication',
            equipment_model: equipment.model,
            manual_version: version,
            limit: 8,
          },
          null,
          '补充英文原版手册条款',
          '核对中文摘要与英文原版是否一致',
          '英文原版用于交叉核对版本和阈值',
        ),
      );
      queries.push(
        query(
          'maintenance_search_manual',
          {
            query: '轴承 温度 振动 传感器 漂移 通讯 阈值',
            equipment_model: equipment.model,
            limit: 8,
          },
          null,
          '确认是否存在其他可用版本的手册',
          '识别版本冲突或已撤回文档',
          '版本冲突时必须转人工，而不是使用旧阈值',
        ),
      );
    }
    if (findings.cases.length === 0) {
      queries.push(
        query(
          'maintenance_search_cases',
          {
            query: '轴承 振动 温度 磨损 不对中 润滑 通讯',
            equipment_model: equipment.model,
            limit: 5,
          },
          null,
          '缺少同机型历史案例',
          '对比历史根因与处理结果',
          '历史案例仅作参考，不能替代本次证据',
        ),
      );
    }
    return {
      summary: `已请求手册与历史案例检索，目标机型 ${equipment.model}。`,
      queries,
    };
  }

  private nextChecks(
    inference: Inference,
    findings: Findings,
    input: RoleCallInput,
  ): QueryRequest[] {
    const checks: QueryRequest[] = [];
    const primary = inference.primary;
    const sectionPrefix =
      primary === 'sensor_drift'
        ? '5.3'
        : primary === 'bearing_wear' ||
            primary === 'misalignment' ||
            primary === 'lubrication'
          ? '6.1'
          : primary === 'false_alarm_threshold'
            ? '5.2'
            : primary === 'false_alarm_comm'
              ? '7.'
              : null;
    if (sectionPrefix) {
      const manual = findings.manuals.find((item) =>
        item.section?.startsWith(sectionPrefix),
      );
      if (manual) {
        checks.push(
          query(
            'maintenance_get_manual_section',
            {
              document_id: manual.documentId,
              page: manual.page,
            },
            null,
            '需要完整条款原文核对判定条件',
            '确认阈值、观察时长与复检要求',
            '搜索结果可能截断条款，完整页用于最终引用',
          ),
        );
      }
    }
    if (
      findings.cases.length === 0 &&
      ['bearing_wear', 'misalignment', 'lubrication'].includes(primary)
    ) {
      checks.push(
        query(
          'maintenance_search_cases',
          {
            query: '轴承 磨损 振动 案例',
            equipment_model: input.equipment.model,
            limit: 5,
          },
          null,
          '缺少同机型机械故障案例',
          '对比历史处理方式',
          '案例用于辅助验证，不作为根因证据',
        ),
      );
    }
    if (findings.mesEvents.length === 0 && primary.startsWith('false_alarm')) {
      checks.push(
        query(
          'equipment_query',
          {
            equipment_id: input.equipment.equipment_id,
            query_kind: 'mes_events',
            window: input.run.window,
          },
          null,
          '假报警判断缺少 MES 事件佐证',
          '确认网络维护或时钟校正',
          'MES 事件能解释报警与数据异常',
        ),
      );
    }
    return checks.slice(0, 2);
  }

  private buildHypothesis(
    code: RootCauseCode,
    inference: Inference,
    findings: Findings,
    input: RoleCallInput,
  ): HypothesisDraft {
    const tempIds = evidenceIds(
      input.evidence,
      (e) =>
        e.payload.kind === 'telemetry_series' &&
        e.payload.metric === 'bearing_temperature',
    );
    const vibIds = evidenceIds(
      input.evidence,
      (e) =>
        e.payload.kind === 'telemetry_series' &&
        e.payload.metric === 'vibration_rms',
    );
    const currentIds = evidenceIds(
      input.evidence,
      (e) =>
        e.payload.kind === 'telemetry_series' &&
        e.payload.metric === 'motor_current',
    );
    const alarmIds = evidenceIds(
      input.evidence,
      (e) => e.payload.kind === 'alarm',
    );
    const statusIds = evidenceIds(
      input.evidence,
      (e) => e.payload.kind === 'status_snapshot',
    );
    const allSeriesIds = evidenceIds(
      input.evidence,
      (e) => e.payload.kind === 'telemetry_series',
      20,
    );
    const mesIds = evidenceIds(
      input.evidence,
      (e) => e.payload.kind === 'mes_event',
    );
    const caseIds = evidenceIds(
      input.evidence,
      (e) => e.payload.kind === 'case_record',
    );
    const manual53 = manualIds(findings, '5.3');
    const manual61 = manualIds(findings, '6.1');
    const manual52 = manualIds(findings, '5.2');
    const manual7 = findings.manuals
      .filter((item) => item.section?.startsWith('7.'))
      .map((item) => item.evidenceId);

    const template = templateFor(code);
    const base = {
      title: '',
      description: '',
      confidence: 'medium' as const,
      rationale: '',
      supporting_evidence_ids: [] as string[],
      contradicting_evidence_ids: [] as string[],
      missing_evidence: [] as string[],
      next_check: template.check.purpose,
    };

    switch (code) {
      case 'sensor_drift':
        return {
          ...base,
          code,
          title: '轴承温度传感器漂移',
          description:
            '温度持续上升，但振动有效值与电机电流保持稳定，符合测点漂移而非机械劣化。',
          confidence: 'high',
          rationale:
            '温度趋势与振动/电流趋势解耦；手册 5.3 要求用独立测温对比确认。',
          supporting_evidence_ids: unique([
            ...tempIds,
            ...manual53,
            ...statusIds,
          ]).slice(0, 12),
          contradicting_evidence_ids: [],
          missing_evidence: ['手持测温对比结果'],
        };
      case 'sensor_stuck':
        return {
          ...base,
          code,
          title: '轴承温度测点卡值',
          description: '温度读数长时间完全不变，疑似传感器或采集通道卡死。',
          confidence: 'high',
          rationale: `温度序列仅 ${findings.series.get('bearing_temperature')?.unique ?? 0} 个不同值，且样本连续。`,
          supporting_evidence_ids: unique([...tempIds, ...statusIds]).slice(
            0,
            12,
          ),
          missing_evidence: ['相邻测点对比'],
        };
      case 'sensor_range':
        return {
          ...base,
          code,
          title: '温度读数超出量程',
          description:
            '温度读数远高于设备正常量程，优先判断为传感器/量程问题。',
          confidence: 'high',
          rationale: '读数超过正常上限数倍，现场工艺参数不支持该温度。',
          supporting_evidence_ids: unique([...tempIds, ...statusIds]).slice(
            0,
            12,
          ),
          missing_evidence: ['传感器量程配置'],
        };
      case 'sampling_gap':
        return {
          ...base,
          code,
          title: '采样数据缺口',
          description: '时间序列存在连续缺失样本，趋势判断的完整性不足。',
          confidence: 'medium',
          rationale: `共缺失 ${findings.missingSamples} 个样本。`,
          supporting_evidence_ids: unique([
            ...evidenceIds(
              input.evidence,
              (e) =>
                e.payload.kind === 'telemetry_series' &&
                e.payload.points.some((point) => point.q !== 'good'),
            ),
            ...statusIds,
          ]).slice(0, 12),
          missing_evidence: ['缺失时段的网关日志'],
        };
      case 'bearing_wear':
        return {
          ...base,
          code,
          title: '轴承磨损',
          description:
            '振动与轴承温度同步上升，电机电流增大，符合轴承磨损的机械劣化特征。',
          confidence: 'high',
          rationale:
            '振动、温度、电流同向恶化；手册 6.1 提示结合油液分析与振动频谱确认。',
          supporting_evidence_ids: unique([
            ...allSeriesIds,
            ...manual61,
            ...caseIds.filter((id) =>
              input.evidence.some(
                (e) =>
                  e.id === id &&
                  e.payload.kind === 'case_record' &&
                  e.payload.root_cause_code === 'bearing_wear',
              ),
            ),
          ]).slice(0, 18),
          contradicting_evidence_ids: [],
          missing_evidence: ['振动频谱', '油液分析结果'],
        };
      case 'misalignment':
        return {
          ...base,
          code,
          title: '联轴器不对中',
          description:
            '振动明显上升而温升有限，电流同步上升，优先怀疑联轴器不对中。',
          confidence: 'medium',
          rationale: '振动劣化主导、温升幅度较小，符合不对中的典型形态。',
          supporting_evidence_ids: unique([
            ...vibIds,
            ...manual61,
            ...caseIds.filter((id) =>
              input.evidence.some(
                (e) =>
                  e.id === id &&
                  e.payload.kind === 'case_record' &&
                  e.payload.root_cause_code === 'misalignment',
              ),
            ),
          ]).slice(0, 12),
          missing_evidence: ['激光对中测量'],
        };
      case 'lubrication':
        return {
          ...base,
          code,
          title: '润滑不良',
          description: '振动与温度中度上升、电流相对稳定，符合润滑状态不良。',
          confidence: 'medium',
          rationale:
            '温升幅度介于传感器漂移与严重轴承磨损之间，需检查油位与油质。',
          supporting_evidence_ids: unique([
            ...vibIds,
            ...tempIds,
            ...manual61,
            ...caseIds.filter((id) =>
              input.evidence.some(
                (e) =>
                  e.id === id &&
                  e.payload.kind === 'case_record' &&
                  e.payload.root_cause_code === 'lubrication',
              ),
            ),
          ]).slice(0, 12),
          missing_evidence: ['油位与油质检查'],
        };
      case 'false_alarm_comm':
        return {
          ...base,
          code,
          title: '通讯链路导致的假报警',
          description:
            '通讯报警/采样缺失与网络维护记录吻合，工艺参数保持正常，不支持机械故障。',
          confidence: 'high',
          rationale: 'MES 记录网络维护，报警期间数据缺失或时间戳乱序。',
          supporting_evidence_ids: unique([
            ...alarmIds,
            ...mesIds,
            ...manual7,
            ...vibIds,
          ]).slice(0, 12),
          missing_evidence: ['网关断连日志'],
        };
      case 'false_alarm_time':
        return {
          ...base,
          code,
          title: '报警时间戳异常',
          description:
            '报警网关时钟偏移，报警时间与趋势数据不一致，报警本身不可信。',
          confidence: 'high',
          rationale: 'MES 记录时钟校正，遥测存在乱序时间戳。',
          supporting_evidence_ids: unique([
            ...mesIds,
            ...alarmIds,
            ...statusIds,
          ]).slice(0, 12),
          missing_evidence: ['NTP 同步记录'],
        };
      case 'false_alarm_threshold':
        return {
          ...base,
          code,
          title: '报警阈值配置错误',
          description:
            '温度最高值仍低于当前手册阈值，报警由旧阈值或错误组态触发。',
          confidence: 'high',
          rationale: '当前手册 v2 的阈值高于报警时的温度读数。',
          supporting_evidence_ids: unique([
            ...alarmIds,
            ...tempIds,
            ...manual52,
          ]).slice(0, 12),
          missing_evidence: ['报警组态当前阈值'],
        };
      case 'false_alarm_recovered':
        return {
          ...base,
          code,
          title: '短时报警已恢复',
          description: '报警已恢复，当前工艺参数正常，未见持续机械劣化。',
          confidence: 'medium',
          rationale: '报警状态为 cleared，趋势在正常范围内。',
          supporting_evidence_ids: unique([
            ...alarmIds,
            ...statusIds,
            ...vibIds,
          ]).slice(0, 12),
          missing_evidence: ['后续重复报警记录'],
        };
      case 'insufficient_evidence':
        return {
          ...base,
          code,
          title: '证据不足，无法确认根因',
          description:
            '关键只读来源不可用、手册版本不匹配或缺少报警时状态，当前不能形成可核查的确定结论。',
          confidence: 'low',
          rationale: inference.handoffReason ?? '缺少关键证据。',
          supporting_evidence_ids: unique([
            ...statusIds,
            ...tempIds,
            ...vibIds,
          ]).slice(0, 8),
          missing_evidence: unique([
            ...(findings.hasTelemetry ? [] : ['报警时段遥测']),
            ...(findings.manualMissing ? ['适用版本手册'] : []),
            ...(findings.manualVersionConflict ? ['与设备匹配的手册版本'] : []),
            ...(findings.sourceFailures.length > 0
              ? [`来源错误：${findings.sourceFailures.join(',')}`]
              : []),
            '现场检查记录',
          ]).slice(0, 10),
        };
      case 'multi_fault':
      case 'unknown':
        return {
          ...base,
          code,
          title: code === 'multi_fault' ? '多项并发异常' : '未分类异常',
          description: '现有证据无法归入单一根因，需要人工复核。',
          confidence: 'low',
          rationale: inference.notes.join('；') || '证据形态不典型。',
          supporting_evidence_ids: unique([
            ...statusIds,
            ...tempIds,
            ...vibIds,
          ]).slice(0, 8),
          missing_evidence: ['现场检查记录'],
        };
    }
  }

  private verify(input: RoleCallInput): HypothesisVerifierOutput {
    const findings = this.findings(input);
    const inference = inferRootCauses({
      findings,
      equipment: input.equipment,
      alarm: input.alarm,
      symptom: input.run.symptom,
      controlIntent: detectControlIntent(input.run.symptom),
    });
    const drafts: HypothesisDraft[] = inference.codes
      .slice(0, 3)
      .map((code) => this.buildHypothesis(code, inference, findings, input));

    // 保留一个关键反证假设，避免只列支持项。
    if (!inference.handoff && inference.codes.length === 1) {
      const primary = inference.primary;
      if (primary === 'sensor_drift') {
        const vibIds = evidenceIds(
          input.evidence,
          (e) =>
            e.payload.kind === 'telemetry_series' &&
            (e.payload.metric === 'vibration_rms' ||
              e.payload.metric === 'motor_current'),
        );
        drafts.push({
          code: 'bearing_wear',
          title: '轴承磨损（已反驳）',
          description: '若为轴承磨损，振动与电流应同步上升；当前两者稳定。',
          confidence: 'low',
          rationale: '振动与电流未随温度上升，反证机械磨损。',
          supporting_evidence_ids: [],
          contradicting_evidence_ids: vibIds.slice(0, 8),
          missing_evidence: ['振动频谱'],
          next_check: null,
        });
      } else if (
        primary === 'bearing_wear' ||
        primary === 'misalignment' ||
        primary === 'lubrication'
      ) {
        const stable = evidenceIds(
          input.evidence,
          (e) =>
            e.payload.kind === 'telemetry_series' &&
            (e.payload.metric === 'vibration_rms' ||
              e.payload.metric === 'motor_current'),
        );
        drafts.push({
          code: 'sensor_drift',
          title: '温度传感器漂移（已反驳）',
          description:
            '若仅为传感器漂移，振动与电流应保持稳定；当前振动同步上升。',
          confidence: 'low',
          rationale: '振动/电流随温度同向变化，反证纯传感器漂移。',
          supporting_evidence_ids: [],
          contradicting_evidence_ids: stable.slice(0, 8),
          missing_evidence: ['手持测温对比'],
          next_check: null,
        });
      } else if (primary.startsWith('false_alarm')) {
        const normal = evidenceIds(
          input.evidence,
          (e) => e.payload.kind === 'telemetry_series',
        );
        drafts.push({
          code: 'bearing_wear',
          title: '轴承磨损（已反驳）',
          description: '若为机械故障，振动/温度应持续恶化；当前工艺值正常。',
          confidence: 'low',
          rationale: '工艺参数正常，反证机械故障。',
          supporting_evidence_ids: [],
          contradicting_evidence_ids: normal.slice(0, 8),
          missing_evidence: ['振动频谱'],
          next_check: null,
        });
      }
    }

    const nextChecks =
      input.stage === 'generate_hypotheses'
        ? this.nextChecks(inference, findings, input)
        : [];

    return {
      summary: `候选根因：${inference.codes.join(', ')}。${inference.notes.join('；')}。${
        inference.handoff ? `转人工：${inference.handoffReason}` : ''
      }`,
      hypotheses: drafts.slice(0, 5),
      next_checks: nextChecks,
    };
  }

  private review(input: RoleCallInput): ReportReviewerOutput {
    const findings = this.findings(input);
    const inference = inferRootCauses({
      findings,
      equipment: input.equipment,
      alarm: input.alarm,
      symptom: input.run.symptom,
      controlIntent: detectControlIntent(input.run.symptom),
    });
    const observations: Observation[] = [];
    const addObservation = (evidence: Evidence | undefined): void => {
      if (!evidence) return;
      const text = describeEvidence(evidence);
      if (!text) return;
      if (observations.some((item) => item.evidence_ids.includes(evidence.id)))
        return;
      observations.push({
        id: `obs_${observations.length + 1}`,
        text,
        evidence_ids: [evidence.id],
      });
    };
    for (const evidence of input.evidence) {
      if (evidence.payload.kind === 'alarm') addObservation(evidence);
    }
    for (const evidence of input.evidence) {
      if (evidence.payload.kind === 'status_snapshot') addObservation(evidence);
    }
    const metricOrder = [
      'bearing_temperature',
      'vibration_rms',
      'motor_current',
      'discharge_pressure',
      'flow_rate',
      'motor_winding_temperature',
    ];
    const observedMetrics = new Set(
      input.evidence
        .filter((item) => item.payload.kind === 'telemetry_series')
        .map((item) =>
          item.payload.kind === 'telemetry_series' ? item.payload.metric : '',
        ),
    );
    const orderedMetrics = [
      ...metricOrder.filter((metric) => observedMetrics.has(metric)),
      ...[...observedMetrics].filter((metric) => !metricOrder.includes(metric)),
    ];
    for (const metric of orderedMetrics) {
      const evidence = input.evidence.find(
        (item) =>
          item.payload.kind === 'telemetry_series' &&
          item.payload.metric === metric,
      );
      addObservation(evidence);
    }
    for (const evidence of input.evidence) {
      if (evidence.payload.kind === 'mes_event') addObservation(evidence);
    }
    for (const evidence of input.evidence) {
      if (evidence.payload.kind === 'manual_chunk') addObservation(evidence);
    }
    for (const evidence of input.evidence) {
      if (evidence.payload.kind === 'work_order') addObservation(evidence);
    }
    for (const evidence of input.evidence) {
      if (evidence.payload.kind === 'case_record') addObservation(evidence);
    }

    const checks: Check[] = [];
    const recommendations: Recommendation[] = [];
    const seenCodes = new Set<string>();
    for (const hypothesis of input.hypotheses) {
      if (hypothesis.status === 'contradicted') continue;
      if (seenCodes.has(hypothesis.code)) continue;
      seenCodes.add(hypothesis.code);
      const template = templateFor(hypothesis.code);
      checks.push({
        id: `chk_${hypothesis.code}`,
        ...template.check,
        evidence_ids: hypothesis.supporting_evidence_ids.slice(0, 8),
      });
      recommendations.push({
        id: `rec_${hypothesis.code}`,
        ...template.recommendation,
        evidence_ids: hypothesis.supporting_evidence_ids.slice(0, 8),
      });
    }

    const missing = unique(
      input.hypotheses.flatMap((hypothesis) => hypothesis.missing_evidence),
    );
    const unresolved = unique([
      ...missing,
      ...(findings.manualVersionConflict ? ['确认与设备匹配的手册版本'] : []),
      ...(findings.sourceFailures.length > 0
        ? [`恢复来源：${findings.sourceFailures.join(',')}`]
        : []),
      ...(detectControlIntent(input.run.symptom)
        ? ['控制/复位请求需由工程师按现场规程处理']
        : []),
    ]).slice(0, 20);

    const handoffReason = inference.handoff
      ? inference.handoffReason
      : input.hypotheses.some(
            (hypothesis) =>
              hypothesis.code === 'insufficient_evidence' &&
              hypothesis.status !== 'contradicted',
          )
        ? '存在未解决的证据缺口，需人工复核。'
        : null;

    const limitations = [
      ...(input.run.data_mode === 'mock'
        ? ['当前为 Mock 模拟数据模式，不能作为现场维修依据。']
        : []),
      ...(input.run.data_mode === 'replay'
        ? ['当前为回放数据模式，结论仅对回放快照有效。']
        : []),
      ...(input.run.model_mode === 'fixture'
        ? ['当前使用 FixtureRoleRunner 预录规则推理，不是真实模型输出。']
        : []),
      ...(findings.sourceFailures.length > 0
        ? [`部分来源不可用：${findings.sourceFailures.join(',')}。`]
        : []),
    ];

    const report: ReportDraft = {
      limitations,
      observations: observations.slice(0, 40),
      hypotheses: input.hypotheses.slice(0, 5),
      checks: checks.slice(0, 12),
      recommendations: recommendations.slice(0, 12),
      unresolved_questions: unresolved,
      handoff_reason: handoffReason,
    };

    return {
      summary: `报告草稿包含 ${report.observations.length} 条观察、${report.hypotheses.length} 个假设、${report.checks.length} 项检查和 ${report.recommendations.length} 条建议。`,
      report,
      review_notes: [
        '所有观察均绑定当前 Run 的 Evidence ID。',
        '控制执行保持禁用，仅提供人工审批建议。',
      ],
    };
  }
}
