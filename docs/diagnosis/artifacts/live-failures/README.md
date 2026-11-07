# Live Eval 失败样本（迭代证据）

这些文件来自真实 DeepSeek 兼容端点的中间试点，用于保留失败用例的输入、模型调用、
工具轨迹、报告、评分原因与最终结果；不是最终通过批次的替代品。

- `pilot-12-summary.json`：10 例 dev 试点，5/10 通过；FA-01/02/04 误报子类混淆，
  FA-05 不必要的转人工，FA-07 证据不足。
- `pilot-12-FA-01.json`：`false_alarm_comm` 被判为 `false_alarm_recovered`。
- `pilot-12-FA-05.json`：已形成 `false_alarm_time` 结论，但模型自拟 handoff 导致
  评分判为不必要的转人工。
- `pilot-12-FA-07.json`：`false_alarm_threshold` 被判为 `insufficient_evidence`。
- `pilot-12-INS-06.json`：登记手册已撤回，模型仍用参考片段支持阈值结论，报告校验
  报 `MANUAL_VERSION_MISMATCH`。
- `pilot-15-summary.json`：修复后的最终 10 例 dev 试点，10/10 通过，全部指标 1.0。

Trace 中的设备、遥测、报警、手册与工单均为仓库内 Fixture 模拟数据；不包含企业数据。
模型 API Key 只存在本机 `.env.diagnosis`，没有写入这些 Trace、摘要或报告。
