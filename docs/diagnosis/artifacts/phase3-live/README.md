# Phase 3 真实模型复验产物

本目录保存 Phase 3“真实 Agent 诊断质量优化”的可复核 Trace。所有 `*.json` 均为
`run-eval.ts` 生成的评测摘要或单例 Trace，未写入 API Key、Endpoint 或凭据。

## 运行环境

- Provider：OpenAI 兼容 Chat Completions（DeepSeek），模型由 `.env.diagnosis`
  配置；仓库与 Trace 不记录 Key。
- 评测集：`evals/diagnosis-phase3/`，10 例开发场景（2 机械、3 多故障、2 传感器、
  3 负例/数据不足），与原始 50 例历史集分开。
- 命令：`npx tsx scripts/diagnosis/run-eval.ts --mode live --eval-dir evals/diagnosis-phase3 ...`
- 单例定向复验：追加 `--case <case_id>`。

## 结果总览

| 产物                                              | 范围                        | 结果                           | 平均延迟  | 模型调用 | 总 token |
| ------------------------------------------------- | --------------------------- | ------------------------------ | --------- | -------- | -------- |
| `full-2/`                                         | 10 例完整尝试（最终修复前） | 6/10 PASS                      | 42,450 ms | 57       | 545,406  |
| `targeted/mechanical-2cases-summary.json`         | 机械鉴别 2 例               | 2/2 PASS                       | 57,106 ms | 14       | 147,458  |
| `targeted/multi-align-lube-summary.json`          | 多故障 1 例                 | 1/1 PASS                       | 70,429 ms | 9        | 79,253   |
| `targeted/multi-bearing-drift-final-summary.json` | 多故障 1 例（预算恢复后）   | 1/1 PASS                       | 65,351 ms | 7        | 76,299   |
| `final-10-not-run.json`                           | 最终 10 例复验              | `NOT_RUN`（HTTP 402 余额不足） | —         | —        | —        |
| `fixture-10-summary.json`                         | 同 10 例 Fixture 回归       | 10/10 PASS（非真实模型）       | 444 ms    | 65       | 454,626  |

`full-2` 是最后一次完整跑完 10 例的真实模型尝试，但早于三项最终修复：

1. 验证阶段修复调用耗尽报告预留时的预算恢复（`budget_fallback`）；
2. MCP 连接阶段异常转为可重试来源错误，而不是把 Run 标为 `failed`；
3. `sensor_drift` 与机械故障并存的采集质量规则。

`full-2` 中 `phase3-mul-bearing-drift` 因第 1 项失败（`UNNECESSARY_HANDOFF`），
`phase3-sen-gap` / `phase3-sen-range` 因第 2 项失败（MCP `Connection closed`），
`phase3-neg-single-sensor` 因模型把温度趋势误判为阈值误报而失败（未解决）。

最终 10 例复验在第一次模型调用即返回 HTTP 402，按预算约束停止，未继续产生付费请求；
该文件记录为 `NOT_RUN`，不能当作 0/10 的模型结果。修复后的定向复验
`targeted/multi-bearing-drift-final-summary.json` 已通过，且
`multi_fault_coverage=1`、`multi_fault_precision=1`。

## 代表性 Trace

- `full-2/phase3-mul-bearing-drift.json`：预算不足导致不必要转人工的失败 Trace；
- `targeted/phase3-mul-bearing-drift.json`：修复后同一场景通过，报告含两个独立根因；
- `full-2/phase3-neg-single-sensor.json`：模型把“温度持续上升但低于手册阈值”判为
  `false_alarm_threshold` 的推理失败；
- `full-2/phase3-sen-gap.json`：MCP 连接关闭的工程失败（修复后未再取得付费复验）；
- `full-2/phase3-mul-align-lube.json`：多故障正例通过，含 `misalignment + lubrication`。

## 结论边界

- 这些 Trace 证明的是“在对应代码状态下，该次真实模型调用得到该结果”，不是通用准确率。
- `full-2` 的 6/10 不能表述为最终代码的 6/10；最终代码的完整 10 例真实复验为 `NOT_RUN`。
- Fixture 10/10 只用于回归，不是真实模型结果。
