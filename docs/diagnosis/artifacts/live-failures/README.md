# Live Eval 失败样本（迭代证据）

这些文件来自真实 DeepSeek 兼容端点的中间试点，用于保留失败用例的输入、模型调用、
工具轨迹、报告、评分原因与最终结果；不是最终通过批次的替代品。

## Pilot 12（5/10）

- `pilot-12-summary.json`：10 例 dev 试点，5/10 通过；FA-01/02/04 误报子类混淆，
  FA-05 不必要的转人工，FA-07 证据不足。
- `pilot-12-FA-01.json`、`pilot-12-FA-02.json`、`pilot-12-FA-04.json`：
  `false_alarm_comm` 被判为 `false_alarm_recovered`。
- `pilot-12-FA-05.json`：已形成 `false_alarm_time` 结论，但模型自拟 handoff 导致
  评分判为不必要的转人工。
- `pilot-12-FA-07.json`：`false_alarm_threshold` 被判为 `insufficient_evidence`。

## Pilot 13（7/10）

- `pilot-13-summary.json`：FA-05 仍为不必要的转人工；FA-09 把
  `false_alarm_recovered` 判成 `false_alarm_threshold`；INS-06 在登记手册已撤回时
  仍用参考片段支持阈值结论，报告校验报 `MANUAL_VERSION_MISMATCH`。
- `pilot-13-FA-05.json`、`pilot-13-FA-09.json`、`pilot-13-INS-06.json`：对应的完整
  Trace、输入、模型调用、工具轨迹、报告与评分结果。

## Pilot 14（7/10）

- `pilot-14-summary.json`：FA-01、FA-02、FA-05 的失败原因是外部端点返回空
  `choices[0].message.content`（`EXECUTION_ERROR`），不是模型诊断结论错误；保留这些
  Trace 用于证明空响应会按执行错误处理、不会伪装成诊断失败。
- `pilot-14-FA-01.json`、`pilot-14-FA-02.json`、`pilot-14-FA-05.json`：对应 Trace。

## 全量 50 例：环境干扰批次（不作为模型质量结论）

- `full-01-summary.json`：2026-11-08 04:08–04:11 的全量 50 例运行，5/50。FA-07 起 44 例
  在首个工具调用即报 `MCP error -32000: Connection closed`；原因是评测期间本地 MCP
  构建重写了 `packages/industrial-diagnosis-mcp/dist/server.js`（文件时间 04:12），
  不是模型诊断结论。该批次不能用于计算真实模型通过率。
- `full-01-FA-07.json`：上述连接关闭的代表性 Trace。
- 修正后的全量重跑结果见下一节或 `ACCEPTANCE.md` §6.1。

## 全量 50 例：稳定构建批次（full-02）

- `full-02-summary.json`：2026-11-08 04:28–05:05 的全量 50 例，23/50 通过
  （dev 14/29、holdout 9/21）。该批次使用修复前的 3,000 报告输出上限，MEC-03、
  MUL-01、MUL-08 因报告 JSON 截断记 `NO_REPORT`；其余失败是真实模型结论或执行问题。
- `full-02-*.json`：27 个失败用例的完整 Trace、输入、模型调用、工具轨迹、报告与评分原因。
- 主要失败类别：机械故障鉴别（misalignment/lubrication 常被 bearing_wear 或
  insufficient_evidence 替代）、多故障覆盖（10/10 失败，漏掉 sensor_drift 等第二根因）、
  传感器异常子类混淆（sensor_drift/sensor_range/sensor_stuck/sampling_gap）、
  反证未引用（vibration_rms），以及 1 例外部分端空响应。
- FA-01 的空响应属于执行错误；MEC-03/MUL-01/MUL-08 属于报告预算工程缺陷，修复后
  复验结果见 `ACCEPTANCE.md` §6.1.1。
- `targeted-budget-MEC-03.json`、`targeted-budget-MUL-01.json`、
  `targeted-budget-MUL-08.json`：报告上限提升到 4,500 后的复验 Trace；MEC-03 通过，
  MUL-01/MUL-08 报告不再截断但根因仍错（多故障推理缺陷）。

## 最终试点

- `pilot-15-summary.json`：修复后的最终 10 例 dev 试点，10/10 通过，全部指标 1.0。

## Phase 3 失败复核

- `docs/diagnosis/FAILURE_ANALYSIS.md`：对 full-02 的 27 条失败逐条分类，区分任务定义/
  证据标准、多故障/互斥、采样缺口、阈值优先、传感器子类型、机械判别、反证/报告状态、
  工程/Provider 与评测口径；并单独记录已修复的报告截断问题。
- 该分析不读取 gold 生成规则，也不把 `case_id` / `expected_root_causes` 注入模型上下文。
- Phase 3 独立 10 例的真实模型复验 Trace 与最终 `NOT_RUN` 记录见
  `docs/diagnosis/artifacts/phase3-live/`；`full-2` 是最终三项修复前的完整尝试，
  不能当作最终代码通过率。

Trace 中的设备、遥测、报警、手册与工单均为仓库内 Fixture 模拟数据；不包含企业数据。
模型 API Key 只存在本机 `.env.diagnosis`，没有写入这些 Trace、摘要或报告。
