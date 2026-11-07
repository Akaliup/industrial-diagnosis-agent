# 工业诊断 Agent 失败分析（Phase 3）

- 分析日期：2026-11-08
- 代码基线：`d0d0750`（Phase 2 合并点），工作分支 `feat/agent-diagnosis-quality`
- 真实模型评测：`full-02`，50 例，23 通过 / 27 失败
- Trace 目录：`docs/diagnosis/artifacts/live-failures/full-02-*.json`
- 模型：DeepSeek OpenAI-compatible Chat Completions，实际响应多为 `deepseek-flash`
- 说明：本文只分析失败 Trace 与模型原始输出，不读取 gold 生成诊断规则，也不把
  `case_id` / `expected_root_causes` 注入模型上下文。

## 1. 基线数字

| 指标                           |         full-02 |
| ------------------------------ | --------------: |
| 总通过率                       |   23/50 = 0.460 |
| false_alarm                    |    7/10 = 0.700 |
| insufficient_safety            |    9/10 = 0.900 |
| mechanical_fault               |    5/10 = 0.500 |
| multi_fault                    |    0/10 = 0.000 |
| sensor_anomaly                 |    2/10 = 0.200 |
| multi-fault Recall / Precision |     0.20 / 0.40 |
| counter-evidence retention     |           0.826 |
| tool selection                 |           0.971 |
| handoff accuracy               |           0.780 |
| mean latency                   |          44.6 s |
| model calls / total tokens     | 337 / 2,736,940 |
| model call failures            |              10 |

失败原因计数（一个案例可有多条）：

| 失败原因                   | 次数 |
| -------------------------- | ---: |
| `ROOT_CAUSE_MISMATCH`      |   26 |
| `UNNECESSARY_HANDOFF`      |   11 |
| `NO_REPORT`                |    4 |
| `EXECUTION_ERROR`          |    4 |
| `MISSING_SUPPORT`          |    4 |
| `MISSING_CONTRADICTION`    |    4 |
| `MISSING_TOOLS`            |    1 |
| `REPORT_VALIDATION_FAILED` |    1 |

## 2. 分类口径

每条失败只归入一个“首要类别”，必要时标注次要类别。类别定义：

| 代码 | 类别                    | 含义                                                                                      |
| ---- | ----------------------- | ----------------------------------------------------------------------------------------- |
| T    | 任务定义 / 证据标准错位 | 模型把“supported”理解成“现场已确认”，因缺少手持测温、频谱、油液、对中或报警组态记录而降级 |
| M    | 多故障 / 互斥规则       | 只输出一个主根因，或用 `multi_fault` 占位，未分别保留独立根因                             |
| Q    | 采样缺口误分类          | 把 `sampling_gap` 当作“数据质量观察”，不敢作为 supported 根因                             |
| H    | 阈值误报优先            | 只要触发值低于手册阈值就判 `false_alarm_threshold`，忽略并存的独立异常                    |
| S    | 传感器子类型            | `sensor_range` / `sensor_stuck` / `sensor_drift` 判别错误                                 |
| E    | 机械判别证据不足        | 只用“振动升高”或“温度升高”单一指标，未比较温度幅度、电流、流量/压力组合                   |
| C    | 反证 / 报告状态         | 反证丢失，或报告层改写已验证状态                                                          |
| G    | 工程 / Provider         | 报告截断、非法 JSON、Provider 空响应                                                      |
| A    | 评测口径 / 场景歧义     | 计分把占位码当根因，或场景本身不可分                                                      |

## 3. 27 条失败总表

| 案例   | 期望 → 实际                                           | 失败阶段        | 类别  | 直接证据                                                                                                      | 根因假设                                                         | 修复位置                                                       | 独立验证                                         |
| ------ | ----------------------------------------------------- | --------------- | ----- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| FA-01  | `false_alarm_comm` → 无报告                           | confirm_status  | G     | `data_investigator MODEL_ERROR 模型响应没有 choices[0].message.content`；3 次调用后仍空                       | Provider 空响应，非推理错误                                      | `live-role-runner.ts` 空响应重试；`orchestrator.ts` 失败转人工 | 单测模拟空 content；live 复验 FA-01              |
| FA-05  | `false_alarm_time` → 同码，但缺反证                   | produce_report  | C     | `MISSING_CONTRADICTION telemetry:EQ-DEMO-001:vibration_rms`                                                   | 报告未保留 vibration_rms 反证                                    | `context-builder.ts` 反证 pin；`orchestrator.ts` 报告反证对账  | `counter_evidence_retained`；context/report 单测 |
| FA-08  | `false_alarm_threshold` → `insufficient_evidence`     | verify_evidence | T+H   | 模型原文：“触发值 72.43°C 低于 80°C……但报警实际配置阈值及来源版本记录缺失……不能标 supported”                  | 把“缺配置记录”当成 supported 前提；阈值规则未区分“无其他异常”    | `context-builder.ts` 结论标准 + 阈值规则                       | 复验 FA-08；构造“无配置记录但阈值矛盾”单测       |
| INS-10 | `sensor_drift` → `false_alarm_threshold`              | produce_report  | H+S   | 温度 65.9→81.37°C 单调升，振动 2.22–2.37、电流 73.7–74.35 平稳；模型仍判阈值误报                              | 温度趋势未算“其他异常”；未识别 drift                             | 阈值规则 + 传感器鉴别 + 异常清单 `trend`                       | 复验 INS-10；feature 单测                        |
| MEC-03 | `bearing_wear` → 无报告                               | produce_report  | G     | `report_reviewer INVALID_OUTPUT ... position 6098`                                                            | 报告输出 3000 token 截断（历史问题）                             | `REPORT_OUTPUT_RESERVE=4500`（已修复）；targeted rerun 通过    | `targeted-budget-MEC-03.json` evaluation passed  |
| MEC-06 | `misalignment` → `insufficient_evidence`              | verify_evidence | T     | 模型：振动上升但“缺频谱/相位/对中记录”，故 inconclusive                                                       | 把现场确认当 supported 前提                                      | 结论标准                                                       | 复验 MEC-06                                      |
| MEC-07 | `misalignment` → `bearing_wear`                       | produce_report  | E     | 振动 2.11→6.17（超 4.5），电流 48.0→50.9，温度 62.1→66.0；模型判 bearing_wear                                 | 只用振动+电流，忽略温升幅度小                                    | 机械鉴别规则 + 温度/振动/电流 delta 特征                       | 复验 MEC-07；feature 单测                        |
| MEC-08 | `misalignment` → `insufficient_evidence`              | verify_evidence | T     | 模型：缺频谱/相位/对中记录                                                                                    | 同 MEC-06                                                        | 结论标准                                                       | 复验 MEC-08                                      |
| MEC-09 | `lubrication` → `bearing_wear`                        | produce_report  | E     | 温度 65.8→74.9，振动 2.29→5.39，电流 73.7→74.35 基本稳定；模型判 bearing_wear                                 | 忽略“电流稳定”对 bearing_wear 的反证                             | 机械鉴别规则要求电流组合                                       | 复验 MEC-09                                      |
| MUL-01 | `bearing_wear+sensor_drift` → 无报告                  | produce_report  | G+M   | 首次 `INVALID_OUTPUT ... position 1370`；targeted rerun 输出 `multi_fault:supported`                          | 截断已修复；随后暴露 `multi_fault` 占位                          | 4500 reserve；禁止 supported `multi_fault`；eval 过滤占位码    | targeted rerun + validator/eval 单测             |
| MUL-02 | `bearing_wear+sensor_drift` → `bearing_wear`          | produce_report  | M+T   | 模型：`sensor_drift inconclusive`（缺手持比对），`multi_fault inconclusive`；报告只 supported bearing_wear    | 多故障未分别 supported；现场确认标准                             | 独立根因规则 + 结论标准 + eval 过滤                            | 复验 MUL-02                                      |
| MUL-03 | `bearing_wear+sensor_drift` → `bearing_wear`          | produce_report  | M+T   | 同 MUL-02，模型只保留主根因                                                                                   | 同上                                                             | 同上                                                           | 复验 MUL-03                                      |
| MUL-04 | `bearing_wear+sensor_drift` → `insufficient_evidence` | verify_evidence | T+M   | 两个假设都因缺现场确认标 inconclusive，触发 handoff                                                           | 同上                                                             | 同上                                                           | 复验 MUL-04                                      |
| MUL-05 | `misalignment+lubrication` → `insufficient_evidence`  | verify_evidence | T+M   | 模型：缺频谱/对中记录                                                                                         | 同上                                                             | 同上                                                           | 复验 MUL-05                                      |
| MUL-06 | `misalignment+lubrication` → `bearing_wear`           | produce_report  | E+M   | 振动 2.x→6.69，温度 61.8→67.8，电流升 4.07；模型判 bearing_wear                                               | 未用温升幅度区分；未同时列 lubrication                           | 机械鉴别 + 独立根因                                            | 复验 MUL-06                                      |
| MUL-07 | `bearing_wear+false_alarm_comm` → `false_alarm_comm`  | produce_report  | M+A+G | 首次 `INVALID_OUTPUT`；重试后只 supported false_alarm_comm；MES 有网络维护；振动升 4.61 但温度/电流平         | 漏 bearing_wear；场景温度平但 MES 文本称“温升”，存在歧义         | 独立根因 + 异常清单；场景歧义只记录，不调 prompt 迎合          | 复验；文档标注歧义                               |
| MUL-08 | `bearing_wear+false_alarm_comm` → 无报告              | produce_report  | G+M+A | 首次 `INVALID_OUTPUT ... position 6188`；targeted rerun 只 `false_alarm_comm`                                 | 截断已修复；仍漏 bearing_wear；场景歧义                          | 同上                                                           | targeted rerun + 复验                            |
| MUL-09 | `sensor_stuck+bearing_wear` → `bearing_wear`          | produce_report  | M     | 振动/电流上升，温度恒定 72°C；模型只判 bearing_wear                                                           | 未逐项解释恒定温度；未保留 sensor_stuck                          | 异常清单 `constant` + 独立根因                                 | 复验 MUL-09                                      |
| MUL-10 | `sensor_stuck+bearing_wear` → 无报告                  | produce_report  | C+M   | 报告把 bearing_wear 从 supported 改成 inconclusive；`HYPOTHESIS_STATUS_DRIFT`；stored 为 supported + 1 条反证 | 报告状态漂移；恒定温度被当成 bearing_wear 反证，未分离为独立故障 | 报告对账 + 反证边界 + 异常清单                                 | orchestrator 单测 + 复验                         |
| SEN-01 | `sensor_drift` → `insufficient_evidence`              | verify_evidence | T     | 模型：温度升、振动/电流稳，符合 5.3，但“缺手持比对，不能 supported”                                           | 现场确认标准                                                     | 结论标准                                                       | 复验 SEN-01                                      |
| SEN-02 | `sensor_drift` → `insufficient_evidence`              | verify_evidence | T     | 同 SEN-01                                                                                                     | 同上                                                             | 同上                                                           | 复验 SEN-02                                      |
| SEN-03 | `sensor_drift` → `insufficient_evidence`              | verify_evidence | T     | 同 SEN-01                                                                                                     | 同上                                                             | 同上                                                           | 复验 SEN-03                                      |
| SEN-06 | `sensor_range` → `sensor_drift`                       | produce_report  | S     | 温度恒 250°C，振动/电流正常；模型引 5.3 判 drift                                                              | 未区分量程饱和与漂移                                             | 传感器鉴别 + `range_limit`                                     | 复验 SEN-06；feature 单测                        |
| SEN-07 | `sensor_range` → `sensor_stuck`                       | produce_report  | S     | 温度恒 250°C；模型判 stuck                                                                                    | 同上                                                             | 同上                                                           | 复验 SEN-07                                      |
| SEN-08 | `sampling_gap` → `insufficient_evidence`              | verify_evidence | Q     | 模型原文：“9 个采样点 missing……属数据质量观察，不作为根因”                                                    | Prompt 明确禁止 sampling_gap supported                           | 数据质量规则                                                   | 复验 SEN-08                                      |
| SEN-09 | `sampling_gap` → `false_alarm_threshold`              | produce_report  | Q+H   | 9 个 missing；模型称“属观察”；温度 < 80 且“无其他异常” → threshold                                            | 采样缺口被排除 + 阈值优先                                        | 数据质量 + 阈值规则 + `missing`                                | 复验 SEN-09                                      |
| SEN-10 | `sampling_gap` → `false_alarm_threshold`              | produce_report  | Q+H   | 同 SEN-09                                                                                                     | 同上                                                             | 同上                                                           | 复验 SEN-10                                      |

## 4. 分类详述

### 4.1 T — 任务定义 / 证据标准错位（10 例）

涉及：FA-08、MEC-06、MEC-08、MUL-02、MUL-03、MUL-04、MUL-05、SEN-01、SEN-02、SEN-03。

这是数量最多的一类，也是此前最容易被误判为“模型推理差”的一类。模型并没有忽略证据，而是严格
执行了系统提示里隐含的“supported = 现场确认”标准：

- SEN-01 原文：“温度单调上升而振动 RMS、电机电流稳定，符合手册 5.3 描述的传感器漂移特征；但缺少
  手持温度计实测比对与校准/更换工单，无法确认漂移量 > 5°C，不能升级为 supported。”
- FA-08 原文：“触发值 72.43°C 低于 v2 手册 80°C 阈值……但报警实际配置阈值及来源版本记录缺失……
  故不能标 supported。”
- MEC-06 原文：“仅有振动升高这一共性证据，缺频谱/相位与对中记录，无法支持或排除。”

这些输出在“现场确认”语义下是谨慎且正确的，但与评测任务的定义冲突：评测要求模型给出
“当前证据下最可复核的根因”，并把现场确认手段放进 `missing_evidence` / `next_check`。
因此这是 **任务定义与 Prompt 语义错位**，不是模型忽略证据。

修复：`context-builder.ts` 的 `hypothesis_verifier` 规则新增“结论标准”，明确 supported 是
“最可复核根因”，允许 medium/low confidence + 缺口；报告层只复述验证状态。

### 4.2 M — 多故障 / 互斥规则（8 例）

涉及：MUL-02、MUL-03、MUL-04、MUL-05、MUL-06、MUL-07、MUL-09、MUL-10（MUL-01/08 同时有工程问题）。

旧 Prompt 有一句：

> 对互斥候选根因，只能保留证据最强的一个为 supported；其余标记 inconclusive 或 contradicted。

模型把这句推广到了所有候选根因。MUL-02 的原始输出同时识别出：

- `bearing_wear:supported`（振动 2.0→6.35，超 4.5，电流 47.1→50.78）
- `sensor_drift:inconclusive`（温度尖峰 79.94/81.1/82.11，前后回落到 65–68）
- `multi_fault:inconclusive`（把两个故障合并成一个占位标签）

它甚至明确写出“温度尖峰孤立且与振动趋势不一致，支持叠加传感器漂移”，但因为“缺便携温度计
比对”而不敢 supported。MUL-01 的 targeted rerun 更直接：`multi_fault:supported` 成为唯一
supported 根因。这说明 `multi_fault` 被模型当成“两个故障”的合法替代，而评测要求具体根因码。

修复：

- 互斥只适用于“同一异常现象的竞争解释”；不同测点/不同机理的独立根因可同时 supported。
- 禁止用 `multi_fault` 作为 supported 假设根因码；报告校验新增 `MULTI_FAULT_PLACEHOLDER`。
- eval 的 `supportedCodes` 过滤 `multi_fault` 占位码，以及非期望的 `insufficient_evidence` /
  `unknown`，避免“多报一个占位码”被当成根因命中。

### 4.3 Q — 采样缺口误分类（3 例）

涉及：SEN-08、SEN-09、SEN-10。

旧 Prompt 有两句直接冲突的规则：

> 区分根因与后果：数据缺失、采样缺口等数据质量问题写入 observations/limitations，不要作为 supported 根因。
>
> 数据质量或采样缺口属于观察，不应标为 supported 根因。

SEN-09 模型原文完全照做：“00:08–00:16 共 9 个采样点标记 missing……属数据路径质量问题，不作为根因。”
但 gold 期望 `sampling_gap`，因为该场景的工艺值全部正常、唯一异常就是采集缺口。这里不是模型
推理错误，而是 Prompt 把“数据不足作为附带限制”与“数据路径本身是根因”混为一谈。

修复：数据路径异常（`sampling_gap` / `false_alarm_time` / `false_alarm_comm`）在有直接证据且
工艺参数正常时可以是 supported 根因；只有“数据不足只是附带限制”才写入 limitations。

### 4.4 H — 阈值误报优先（6 例，含交叉）

涉及：FA-08、INS-10、SEN-09、SEN-10、MEC-07、MEC-09。

旧 Prompt 的优先级规则是：

> 4. 报警仍 active 且触发值低于手册阈值、无其他异常 → false_alarm_threshold。

模型把“无其他异常”理解成“没有别的报警”，而不是“没有别的测点异常”。INS-10 中温度
65.9→81.37°C 单调上升，模型仍写“振动、电流、压力、流量均正常，排除机械与数据路径因素”，
于是判阈值误报。SEN-09/10 中 9 个采样点缺失也被当成“观察”，不构成“其他异常”。

修复：阈值误报必须同时满足“无其他独立异常（振动/电流/温度趋势、尖峰、恒定、采样缺口、
通讯事件）”；存在独立异常时先诊断该异常，阈值矛盾只能作为次要观察。

### 4.5 S — 传感器子类型（3 例）

涉及：INS-10、SEN-06、SEN-07。

SEN-06/07 的温度整窗恒为 250°C，模型分别判 `sensor_drift` 和 `sensor_stuck`。250°C 远超
NP-200 的正常范围 40–80°C，且 `unique=1`，这是量程/物理边界饱和，不是“逐步漂移”，也不是
“合理范围内的卡值”。模型缺少一个显式的子类型判别规则。

修复：Prompt 增加 `sensor_range` / `sensor_stuck` / `sensor_drift` / `sampling_gap` 的判别
条件；上下文新增 `range_limit`、`constant`、`trend`、`spike`、`missing` 特征。所有阈值仍以
设备型号的正常范围/手册限值为依据，不写死 250°C。

### 4.6 E — 机械判别证据不足（3 例）

涉及：MEC-07、MEC-09、MUL-06。

三个案例的模型都只用了“振动升高 + 电流升高 = 轴承磨损”这一条手册 6.1 规则，没有比较温升幅度：

- MEC-07（gold `misalignment`）：振动 2.11→6.17，温度仅 62.1→66.0（Δ4°C），电流 48→50.9。
- MEC-09（gold `lubrication`）：振动 2.29→5.39，温度 65.8→74.9（Δ9°C），电流 73.7→74.35
  （基本稳定）。
- MUL-06（gold `misalignment+lubrication`）：振动上升，温度 61.8→67.8（Δ6°C），电流升 4.07。

MEC-09 的模型甚至写出“电流基本稳定”，却仍把 bearing_wear 标为 supported，说明它没有把
“电流稳定”当作 bearing_wear 的反证。上下文此前只给 `min/max/avg/missing`，没有给首末差、
尖峰数、不同读数、正常范围，模型难以做组合比较。

修复：`analysis.ts` 新增 `deriveTelemetryFeatures`，上下文“已验证事实”输出首末差、Δ、正常范围、
unique、尖峰、缺失；Prompt 增加 bearing_wear / misalignment / lubrication 的组合鉴别方向，
并明确“不是通用阈值，必须引用手册限值与本次证据”。

### 4.7 C — 反证 / 报告状态（2 例）

涉及：FA-05、MUL-10。

- FA-05：根因码正确，但报告没有保留 `vibration_rms` 反证，`counter_evidence_retained` 扣分。
- MUL-10：验证阶段 `bearing_wear` 被标为 supported，同时保留 1 条反证（恒定 72°C）。报告第一次
  复述 supported，校验报 `SUPPORTED_WITH_CONTRADICTION`；修复重试时模型把状态改成 inconclusive，
  又触发 `HYPOTHESIS_STATUS_DRIFT`，最终报告无效。

这不是单纯的“报告写错”。根因是验证阶段允许“supported + 未处理反证”落库，且没有把
“支持另一个独立根因的证据”与“本假设的反证”分开。恒定温度其实是 `sensor_stuck` 的证据，
不是 bearing_wear 的反证。

修复：

- `deriveStatus` 对声明 supported 但仍有反证、或声明 contradicted 但无反证的假设做一致性归一化。
- 报告层 `reconcileReportHypotheses` 以假设库为准恢复 status / 支持证据 / 反证，并补回被删掉的
  已验证假设；纠正写入 `report.reconciled` 事件，不静默修改。
- Prompt 增加“反证边界”：只有直接反驳该机理的证据才算 contradicting。

### 4.8 G / A — 工程、Provider 与评测口径

涉及：FA-01（Provider）、MEC-03 / MUL-01 / MUL-08 / MUL-07 首次尝试（报告截断/非法 JSON）、
MUL-07 / MUL-08（场景歧义）、MUL-01 / MUL-02（占位码计分）。

**历史已修复：报告输出截断。** full-02 中 MEC-03、MUL-01、MUL-08 的 `report_reviewer` 输出在
约 3,000 token 处被截断，JSON 在 position 1370–6188 处非法；MUL-07 第一次尝试也非法、重试成功。
Phase 2 已通过 `REPORT_OUTPUT_RESERVE = 4_500` 为报告预留输出额度。targeted rerun 结果：

| 案例   | 截断是否消失 | 报告是否有效 | 根因是否修复                                       |
| ------ | ------------ | ------------ | -------------------------------------------------- |
| MEC-03 | 是           | 是           | 是（bearing_wear）                                 |
| MUL-01 | 是           | 是           | 否（输出 `multi_fault:supported`，暴露占位码问题） |
| MUL-08 | 是           | 是           | 否（只输出 false_alarm_comm，漏 bearing_wear）     |

因此“报告截断”应作为已修复的工程问题单独记录，不能混入“模型多故障推理失败”。MUL-01 的
targeted rerun 反而证明：截断修好后，真正的多故障/占位码问题才暴露出来。

**Provider 空响应。** FA-01 的 `data_investigator` 三次都返回空 `choices[0].message.content`，
`live-role-runner` 已按可重试错误处理，但本次仍未恢复。这是 Provider 侧不稳定，不是诊断推理。
后续 live 复验需单独记录，不应计入 Prompt 质量。

**评测口径。** full-02 的 `supportedCodes` 把 `multi_fault` 和 `insufficient_evidence` 都当作
根因码。MUL-02 的输出 `bearing_wear + multi_fault` 因此被算成“多报一个根因”，precision 失真；
MUL-04/05 的 `insufficient_evidence` 也会参与集合比较。已改为：`multi_fault` 永远不作为具体
根因计数；`insufficient_evidence` / `unknown` 只在 gold 本身期望该结论时计数。该修改不改变
任何 gold，也不降低门槛。

**场景歧义。** MUL-07/08 的 gold 是 `bearing_wear + false_alarm_comm`，但场景中温度 Δ≈0、
电流 Δ≈0，只有振动上升；MES 文本却写“振动与温升”。模型只判 `false_alarm_comm` 在数据上
是可辩护的。本文将其标为“场景可分辨性不足”，不通过调 Prompt 去迎合这两个案例；后续新增
独立场景时应把“轴承磨损”的证据写得更完整（温度或电流至少一项同向）。

## 5. 不把失败都归因于 Prompt

27 条失败的归因分布（按首要类别）：

| 类别                  |        数量 | 说明                                    |
| --------------------- | ----------: | --------------------------------------- |
| T 任务定义 / 证据标准 |          10 | Prompt 语义与评测定义冲突，可用规则修复 |
| M 多故障 / 互斥       |           8 | 规则设计错误，可用规则修复              |
| Q 采样缺口            |           3 | Prompt 明确写反，可用规则修复           |
| H 阈值优先            | 6（含交叉） | 规则缺少“其他独立异常”约束              |
| S 传感器子类型        |           3 | 缺少子类型判别                          |
| E 机械判别            |           3 | 上下文特征不足 + 规则不足               |
| C 反证 / 报告状态     |           2 | 存储/报告一致性缺陷                     |
| G 工程 / Provider     | 5（含交叉） | 截断已修复；Provider 空响应非推理       |
| A 评测 / 场景         | 3（含交叉） | 计分口径 + 场景歧义                     |

结论：至少 5 条涉及工程/Provider/评测口径，2 条场景本身可分辨性不足；不能把 27 条全部
归因于“模型推理差”或“Prompt 不好”。真正的模型推理错误主要集中在机械判别（E）和部分
多故障证据分离（M），其余是任务定义、规则设计和工程一致性问题。

## 6. 修复后的独立验证方法

| 修复                                                      | 离线验证                                                                                                      | 真实模型验证                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 结论标准 / 独立根因 / 数据质量 / 阈值 / 传感器 / 机械鉴别 | `tests/diagnosis/context-builder.test.ts`、`analysis-features.test.ts` 断言特征与规则文本；Fixture Eval 50/50 | Phase 3 pilot：2 机械 + 2 传感器 + 2 多故障 + 1 反证 + 1 单故障负例 |
| 异常清单 / 动态复核                                       | `deriveTelemetryFeatures` / `deriveAnomalyLedger` 单测；orchestrator 复核路径                                 | 观察 pilot 的 model_calls / tokens / latency 与是否新增第二轮       |
| 报告状态对账                                              | `orchestrator.test.ts` 的 `ReportStatusDriftRunner` 用例；`report-validator.test.ts`                          | 复验 MUL-10 / MUL-01                                                |
| 占位码计分                                                | `eval-scorer.test.ts` 三个用例                                                                                | 复验 MUL-01 / MUL-02                                                |
| 报告截断                                                  | targeted rerun 已有证据                                                                                       | 不再重复付费验证，保留 `targeted-budget-*.json`                     |

## 7. 未解决与风险

1. **场景可分辨性**：MUL-07/08 的 bearing_wear 证据弱，模型只判 comm 误报是合理的。后续
   新增独立场景时应保证每个注入故障都有至少两个独立测点证据，否则应放宽 gold 或标注歧义。
2. **Provider 稳定性**：FA-01 的空响应仍可能随机出现；重试只能缓解，不能消除。
3. **真实模型泛化**：本文的修复仍需要在未参与调试的 Phase 3 场景上单次复验；不能把
   full-02 的回归当作泛化证据。
4. **手册覆盖**：misalignment / lubrication / sensor_range / sensor_stuck / sampling_gap
   在现有手册中没有明确条款，Prompt 只能给“鉴别方向”，不能伪装成手册结论；报告中必须
   保留这一限制。
5. **报告对账的边界**：对账只恢复已验证状态与证据 ID，不修改模型的文字描述；如果模型文字
   与状态矛盾，仍应由人工复核发现，不能由代码自动改写叙述。

## 8. Phase 3 复验中的新增失败与修复记录

本节记录 Phase 3 修复后在 10 例开发场景上的中间复验，不替代 full-02 的历史基线，也不把
中间失败算作最终通过率。所有 case_id 只出现在评测产物中，不进入模型上下文。

需要明确：这 10 例在调试期间被用于定位报告层、多故障和预算问题，已经是**已调试开发集**，
不是未触碰的 holdout。定向 PASS 只能证明对应缺陷在该场景上被修复，不能作为泛化证据；
最终完整复验为 `NOT_RUN`，泛化结论必须等待新的、未参与调试的场景集。

### 8.1 报告层：`status_note` / `status_note_placeholder` 与修复截断

首轮 10 例复验的前两例在 `report_reviewer` 失败：

| 用例               | 第一次输出                                                                                             | 修复调用                                                   | 失败分类               |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------- |
| `phase3-mec-align` | Schema 拒绝 `report.hypotheses.*: Unrecognized key: "status_note"`（5,883 字符 / 2,775 output tokens） | 非法 JSON，position 6230 截断（6,264 字符 / 2,929 tokens） | S 报告 Schema / G 工程 |
| `phase3-mec-lube`  | 同一 `status_note` 额外字段                                                                            | 同一 Schema 错误                                           | S 报告 Schema          |

诊断结论本身已经正确（misalignment / lubrication），失败发生在报告序列化层。处理：

1. `HypothesisDraftSchema` 增加可选 `status_note`（≤300 字），仍保持 `.strict()`；
   其他未知字段继续拒绝。`tests/diagnosis/contracts.test.ts` 覆盖“接受 status_note、拒绝
   其他未知字段”。
2. 报告提示增加精简约束（observations ≤8、checks/recommendations ≤4、每条描述 ≤300 字）
   和“只能使用 Schema 字段、JSON 必须完整闭合”的要求。
3. 修复调用提示要求只输出一个完整合法 JSON，不得添加 Schema 外字段，内容过长先精简再输出。
4. 复验：上述 2 例均 PASS；报告输出 3,337 / 3,208 tokens，5 条假设，`status_note` 正常保留，
   无 Schema 错误或截断。

第二轮完整复验的第三例又出现模型自造字段 `status_note_placeholder: null`。第一次输出是
完整 JSON，仅因该字段被严格 Schema 拒绝；修复调用在 3,380 字符处被 Provider 截断。处理：

- `role-runner.ts` 在解析 `hypothesis_verifier` / `report_reviewer` 输出前，只归一化
  `status_note*` 注解：字符串值收敛到 `status_note`，`null`/占位值丢弃；其他未知字段仍由
  严格 Schema 拒绝。`tests/diagnosis/live-role-runner.test.ts` 覆盖 null 与字符串两种变体。
- 提示明确“不得写成 status_note_placeholder 等变体，不需要时省略”。

这不是放宽证据/引用/安全门禁，只避免无业务含义的注解字段触发整篇长报告重写；原始输出仍
保存在 `diagnosis_model_calls.raw_output`，可审计。

### 8.2 多故障场景 `phase3-mul-align-lube`：先修场景可判别性，再修模型判定

该例目标是 misalignment + lubrication。中间复验出现三次不同结果：

1. 初始场景电流 Δ4.4 A、温度 Δ6°C。模型输出 `bearing_wear + misalignment`，把电流上升作为
   轴承磨损证据。数据上这是可辩护的：NP-300 手册 §6.1 明确“振动上升 + 电流上升 → 轴承磨损”，
   而润滑不良的鉴别方向是“电流基本稳定”。因此该版本场景本身不具判别性，不能算模型错误。
   已将场景改为电流 Δ2.6 A（低于特征层 10% 量程趋势阈值）、温度 Δ9°C，并保留 MES 负荷 +5%
   事件；fixture 仍 10/10。
2. 修正场景后，模型正确排除 bearing_wear、支持 misalignment，但仍把 lubrication 判为
   inconclusive，理由是“温度 73.68°C 距 85°C 限值尚远、缺油液分析”。这是真实的模型判定
   偏保守：结论标准允许把油液分析写入 missing_evidence 并以 medium/low confidence 支持，
   且 misalignment 与 lubrication 共享振动/温度证据不等于互斥。
3. 增加两条通用规则后复验 PASS：
   - 工况混杂：MES 负荷变化可解释的电流升幅不得作为轴承磨损支持证据；
   - 机械并存：misalignment 与 lubrication 各有独立判别维度，共享振动/温度证据不构成互斥，
     缺少油液/对中记录写入各自缺口，不因缺现场记录把已有判别性遥测支持的 lubrication 降级。

该例同时说明：多故障 Recall 不能靠“多报一个根因”获得；最终 PASS 是 coverage=1、
precision=1，而不是用 bearing_wear 替换 lubrication。场景修正与规则修正分别记录，避免把
场景缺陷伪装成模型失败，也避免用 gold 迎合模型输出。

### 8.3 本轮未解决的模型行为

- 模型仍倾向于要求现场确认（油液、频谱、对中记录）才把机械假设标为 supported；提示已明确
  “缺现场确认不等于 inconclusive”，但该行为可能在其他机型/工况上复现。
- 报告层对模型自造字段的容忍只覆盖 `status_note*`；其他未知字段仍会触发一次修复调用。
- `phase3-neg-single-sensor` 中，温度从 66°C 持续升到 75.65°C、振动/电流/流量平稳，模型仍把
  “触发值低于 NP-300 手册 85°C 阈值”判为 `false_alarm_threshold` supported，把
  `sensor_drift` 降为 inconclusive。规则已要求“存在温度趋势时不得只按阈值矛盾判误报”，但
  模型没有执行；这是未解决的推理问题，不能用调低门槛或改 gold 掩盖。
- 上述修复均在 Phase 3 独立场景上验证，不能外推为企业现场精度。

### 8.4 验证阶段预算耗尽导致不必要转人工（工程缺陷）

完整复验中 `phase3-mul-bearing-drift` 的验证阶段最后一次调用返回非法 JSON（position 3431），
修复调用只剩报告预留的 4,500 output tokens，`outputAllowance` 抛出 `BudgetExceededError`；
`execute` 的 catch 无条件调用 `handoff`，把已有 `bearing_wear` supported 的 Run 转人工，
评测报 `UNNECESSARY_HANDOFF`。Trace 中累计输出恰为 7,500 tokens，证据为
`full-2/phase3-mul-bearing-drift.json`。

修复：

- `execute` 捕获 `BudgetExceededError` 时，如果当前阶段不是 `produce_report`、仍有剩余输出额度、
  且已存在 supported 诊断假设，则设置 `budget_skipped_final_verify`，发出
  `stage.changed(reason=budget_fallback)`，用报告预留额度生成报告；报告仍进入人工复核，并在
  limitations 中写明“最后一次复核因输出预算保留而跳过”。
- 该恢复失败时仍回退到原有 `handoff`，不吞掉预算错误。
- `tests/diagnosis/orchestrator.test.ts` 新增 `BudgetExhaustedVerifyRunner`：验证阶段返回
  `INVALID_OUTPUT` 且已消耗 7,000 output tokens，断言最终 `handoff_reason=null`、报告校验通过、
  `bearing_wear` supported、limitations 含“输出预算”，并产生 `budget_fallback` 事件。

修复后定向复验 `phase3-mul-bearing-drift` PASS（65,351 ms，7 次模型调用，76,299 tokens，
coverage=1、precision=1），Trace 见 `artifacts/phase3-live/targeted/phase3-mul-bearing-drift.json`。

### 8.5 MCP 连接关闭把 Run 标为 failed（工程缺陷）

完整复验的第 9、10 例 `phase3-sen-gap` / `phase3-sen-range` 在第一次 `equipment_resolve`
时出现 `MCP error -32000: Connection closed`，Run 直接 `failed`，工具日志为
`RECEIPT_UNKNOWN`。同一场景在 Fixture 模式 2/2 PASS，说明场景与工具实现本身可用；问题在
MCP 客户端：`ensureConnected()` 位于 `callRaw` 的 try 之外，连接阶段异常会穿透网关和编排层。

修复：

- `callRaw` 把 `ensureConnected()` 放入 try；连接失败按既有 `SOURCE_UNAVAILABLE`（retryable）
  返回，由 `callWithRetry` 重建连接并重试，最终由预算/转人工路径收口，而不是把 Run 标为 failed。
- `ensureConnected()` 在 `client.connect` 失败时关闭半开 transport 并清空 client/transport，
  避免下一次重试复用坏连接。
- 新增 `tests/diagnosis/mcp-client.test.ts`：让 MCP 子进程在启动时退出，断言 `callRaw` 返回
  `status=error`、`code=SOURCE_UNAVAILABLE`、`retryable=true`，而不是抛出未包装异常。

该修复后的真实模型复验为 `NOT_RUN`：最终 10 例复验在第一次模型调用即返回 HTTP 402（余额不足），
按预算约束停止。Fixture 10/10 只证明回归路径，不替代真实模型验证。

### 8.6 `sensor_drift` 与机械故障并存的采集规则

`phase3-mul-bearing-drift` 的第二次失败（预算修复后）是模型只输出 `bearing_wear`：
它承认温度尖峰“支持传感器异常”，但把振动/电流上升当作 `sensor_drift` 的反证。原规则把
`sensor_drift` 定义为“读数逐步偏离且振动/电流稳定”，与该多故障场景的“机械趋势 + 单通道尖峰”
不符，属于规则覆盖不足，不是单纯模型错误。

处理：在 `context-builder` 的传感器规则中区分“温度异常全部由传感器造成”和“机械故障与传感器
异常并存”：机械故障解释连续趋势，单通道尖峰/跳变/与负荷不符的偏置解释采集异常；相关测点同步
上升只能反驳前者，不能反驳后者。规则仍要求尖峰/偏置有直接证据、机械趋势另有支持，避免为了
提高 Recall 而多报。`tests/diagnosis/context-builder.test.ts` 覆盖“采集共存 / 不能反驳”。

修复后定向复验 PASS（coverage=1、precision=1），Trace 见
`artifacts/phase3-live/targeted/multi-bearing-drift-final-summary.json`。该规则只使用遥测形态与
数据质量，不读取 case_id 或 gold。

### 8.7 完整 10 例复验的实际结果与边界

最后一次完整跑完的真实模型尝试是 `full-2`（最终三项修复之前）：6/10 PASS，
multi-fault coverage 0.833、precision 1.0，平均 42,450 ms，57 次模型调用，545,406 tokens。
通过的 6 例为 `mec-align`、`mec-lube`、`mul-align-lube`、`mul-bearing-comm`、
`neg-bearing`、`neg-insufficient`；失败的 4 例分别对应 8.3–8.5 的三类问题。

最终 10 例复验在第一次模型调用即 HTTP 402，记录为 `NOT_RUN`，不是 0/10 的模型结果，也没有
继续产生付费请求。因此：

- 不能声称最终代码在 10 例上达到 10/10 或某个新的总体通过率；
- 可复核的结论是：三项工程/规则修复分别有定向 PASS 与单测覆盖；
- `neg-single-sensor` 的模型误判仍未解决，保留为失败样本；
- 原始 50 例 Fixture Eval 仍为 50/50 历史回归，不代表真实模型精度。
