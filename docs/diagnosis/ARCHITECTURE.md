# 设备智诊架构

## 1. 总览

```mermaid
flowchart LR
  A[报警 Webhook / 演示种子] --> B[诊断收件箱]
  B --> C[Diagnosis Run]
  C --> D[五阶段 Orchestrator]
  D --> E[RoleRunner<br/>Fixture 或 Live]
  D --> F[PolicyGateway]
  F --> G[只读 MCP 服务<br/>stdio JSON-RPC]
  G --> H[Fixture Store / REST Adapter / RootCloud UNCONFIGURED]
  F --> I[本地知识库<br/>FTS5 + PDF/Markdown]
  F --> J[Evidence 入库]
  J --> K[报告生成 + 引用校验]
  K --> L[人工复核 / 建议审批]
  C --> M[SQLite diagnosis_* 表]
  M --> N[WebSocket 事件 + 刷新补拉]
  N --> O[React 工作台]
```

- Web 入口：`/diagnosis`，独立 SPA（HashRouter），复用 Miniclaw 登录与 Workspace。
- 服务入口：`src/diagnosis/server.ts`，只挂载 `/api/auth` 与 `/api/diagnosis`。
- 诊断状态真相源：SQLite 的 `diagnosis_*` 表；WebSocket 只是通知通道。
- 通用 Miniclaw Agent 的工具权限不被诊断链路使用；诊断工具固定白名单。

## 2. 五阶段

| 阶段 | 目标 | 典型工具 | 退出条件 |
| --- | --- | --- | --- |
| `confirm_status` | 确认设备状态、报警真实性、数据可用性 | `equipment_resolve`、`equipment_query(status/alarms)` | 状态与报警窗口明确 |
| `locate_anomaly` | 定位温度/振动/电流/压力/流量异常 | `equipment_query(telemetry/mes_events/work_orders)` | 关键测点趋势与时间窗明确 |
| `generate_hypotheses` | 生成候选根因与判别条件 | 手册/案例检索、`evidence_get` | 至少一个可验证假设 |
| `verify_evidence` | 按假设补查、保留反证、检查证据缺口 | 手册条款、历史案例、补充时序 | 支持/反证/缺口明确 |
| `produce_report` | 生成报告、逐条引用校验 | `evidence_get`、校验器 | 校验通过或明确转人工 |

预算默认值：8 轮总轮次、3 轮/阶段、32 次逻辑工具调用、3 次/调用尝试、16 次模型调用、
300 秒墙钟、单查询窗口 ≤24 小时、无新证据轮次 ≤3。模型调用采用预留/结算式额度：
每次调用先占用调用数与输出 token，返回后按实际用量结算；重试和四个角色共享同一份累计
预算。工具超时取“剩余墙钟”与“单次来源超时”的较小值。证据不足或来源失败进入
`awaiting_human`，不生成确定结论。

## 3. 角色与工具权限矩阵

| 工具 | 风险 | data_investigator | knowledge_retriever | hypothesis_verifier | report_reviewer |
| --- | --- | --- | --- | --- | --- |
| `equipment_resolve` | read | ✓ | — | ✓ | — |
| `equipment_query` | read | ✓ | — | ✓ | — |
| `maintenance_search_manual` | knowledge_read | — | ✓ | ✓ | — |
| `maintenance_get_manual_section` | knowledge_read | — | ✓ | ✓ | — |
| `maintenance_search_cases` | knowledge_read | — | ✓ | ✓ | — |
| `evidence_get` | read | ✓ | ✓ | ✓ | ✓ |
| 任意 Bash/Write/控制工具 | — | ✗ | ✗ | ✗ | ✗ |

网关顺序：认证 → Workspace/Run → 角色白名单 → 严格 Schema → 设备作用域 → 风险 →
预算 → 重复调用守卫 → 租约令牌校验 → 派发前 `inflight` 日志 → 执行 → 回执 → 取消检查 →
证据入库。未知工具、控制风险、越界设备、额外字段一律拒绝。

派发前日志与租约围栏解决两类崩溃/并发问题：

- 请求已发出但回执未落库：恢复时把遗留 `inflight` 标记为 `unknown`，不当作成功或未执行；
- 取消后迟到回执：只关闭日志为 `cancelled`，不写证据、不进入重复调用缓存。

## 4. Tool Schema（输入摘要）

| 工具 | 输入 |
| --- | --- |
| `equipment_resolve` | `query`(1-128)、可选 `vendor`、`model`；严格对象 |
| `equipment_query` | `equipment_id`、`query_kind`(status/telemetry/alarms/mes_events/work_orders)、可选 `alarm_code`、`window`、`metrics[]`、`limit`、`cursor` |
| `maintenance_search_manual` | `query`(1-200)、可选 `equipment_model`、`manual_version`、`limit` |
| `maintenance_get_manual_section` | `document_id`、可选 `chunk_id`、`page` |
| `maintenance_search_cases` | `query`、可选 `equipment_model`、`asset_category`、`limit` |
| `evidence_get` | `evidence_ids[]`(1-50) |

所有输入 `.strict()`，未知字段拒绝。工具输出统一为 `ToolResponseEnvelope`：
`schema_version / request_id / logical_call_id / data_mode / status / data / evidence /
coverage / warnings / error / next_cursor`。`status` 为 `success|partial|no_data|error`。

## 5. 数据模型

| 表 | 用途 |
| --- | --- |
| `diagnosis_meta` | 诊断 Schema 版本 |
| `equipment_registry` | 设备台账快照（型号、厂商、序列号） |
| `diagnosis_sources` | 来源配置与状态（mock/replay/live、UNCONFIGURED） |
| `diagnosis_alarms` | 报警入库与幂等键 |
| `diagnosis_runs` | Run 状态、阶段、预算、租约、单调 `lease_token`、checkpoint、复核状态 |
| `diagnosis_hypotheses` | 候选根因、状态、支持/反证证据 |
| `diagnosis_evidence` | 证据载荷、hash、来源定位、质量标记、手册文档/版本快照 |
| `diagnosis_tool_calls` | 每次逻辑调用与尝试、策略决策、耗时；`inflight → success/partial/no_data/error/unknown/cancelled` |
| `diagnosis_events` | Run 内单调 `seq` 事件 |
| `diagnosis_reports` | 报告 JSON 与校验结果 |
| `diagnosis_reviews` | 人工复核记录 |
| `diagnosis_approvals` | 建议审批意图（控制执行禁用） |
| `diagnosis_control_receipts` | 隔离 fake actuator 的回执状态（本版不执行控制） |
| `knowledge_documents` / `knowledge_chunks` | 手册/案例文档与页级分块 |
| `knowledge_chunks_fts` | FTS5 trigram 索引（可用时） |
| `diagnosis_context_manifests` | 每轮上下文来源与预算清单 |
| `diagnosis_eval_runs` | 50 例 Eval 结果与 trace 路径 |

迁移由 `src/diagnosis/db.ts` 在事务中执行，带备份目录参数；诊断表不改变 Miniclaw 主
Schema 版本语义。

## 6. 事件协议

事件字段：`event_id / run_id / seq / timestamp / type / payload / schema_version`。
`seq` 在 Run 内单调递增，先写数据库再广播。至少包括：

```text
run.created, run.started, stage.changed, tool.started, tool.finished,
evidence.added, hypothesis.updated, report.ready, review.required,
run.awaiting_human, run.completed, run.failed, run.cancelled
```

WebSocket：`/ws/diagnosis?run_id=...&after_seq=...`。服务端先订阅再发送 backlog，
客户端断线后用最后 `seq` 补拉；事件按 `seq` 去重排序。

## 7. 证据与引用

- 证据 ID 在入库时按 Workspace/Run/来源/记录/payload hash 重新计算，模型不能伪造。
- 报告校验：引用存在、属于当前 Run/设备、时间窗匹配、文档已登记、手册版本与设备登记一致、
  文档未撤回、生效日期有效、payload hash 一致、支持/反证关系成立、假设状态与证据关系无漂移、
  控制执行字段为 `disabled`、Mock/Fixture 免责声明存在。
- 手册引用保留文档 ID、版本、页码与 chunk；撤回文档不参与新检索，但历史报告引用仍可打开。
- 诊断/安全两类检查与建议分开校验：安全提示可以没有证据引用，诊断结论不能。
- 证据不足的兜底报告使用 `kind: safety`，不会伪装成有证据支撑的诊断结论。

## 7.1 Trace replay 与 Eval 评分

- Trace replay 只读已保存的 Run/工具调用/证据/报告/事件，重新执行 `evaluateCase` 并比较
  存储评分与重算评分；不启动 MCP、不调用模型、不读取 gold 作为 Agent 输入。
- `npm run diagnosis:replay` 默认回放最近一次 Eval 的 traces，也可指定文件或目录；发现引用
  缺失、作用域错误、事件缺口或评分不一致时退出码为 1。
- Fixture 重跑是独立的回归测试（`eval-fixture-regression.test.ts`），与 replay 区分命名。
- Eval 指标区分“已执行”与“被策略阻断”；被拒绝/未派发的调用不进入执行率与工具召回，
  适用用例的分母随结果输出，避免把空集当成 1.0。

## 7.2 来源健康检查

```text
POST /sources/:id/test
  → 读取服务端 DIAGNOSIS_REST_BASE_URL / TOKEN / ENDPOINTS
  → 只读 resolve 请求
  → 校验 matches 与当前设备映射
  → 成功: status=configured；失败: unconfigured + 安全错误消息
POST /runs (data_mode=live)
  → liveSourcesReady 检查
  → 无 configured 来源: 409 ADAPTER_NOT_CONFIGURED
  → 有来源: 正常编排；适配器不伪造证据，缺证据时转人工
```

本地假 REST 只用于验证配置链路，不改变企业来源的 `UNCONFIGURED` 状态。

## 8. Web 页面

| 路由 | 功能 |
| --- | --- |
| `#/inbox` | 报警收件箱、状态统计、载入演示数据、开始/查看诊断 |
| `#/runs/new` | 从报警或设备发起诊断，选择时间窗与症状 |
| `#/runs/:runId` | 工作台：五阶段、报告、候选根因、证据抽屉、时间线、工具轨迹、复核/审批 |
| `#/equipment`、`#/equipment/:id` | 设备台账与最近诊断 |
| `#/sources` | 来源状态、文档导入/撤回、适配器配置状态 |
| `#/reviews` | 待复核任务与审批 |
| `#/eval` | 50 例 Eval 结果、指标、Trace 回放 |

视觉：白底、黑字、蓝色强调，Lucide 图标，无 Emoji；元素进入/过渡/退出；支持
`prefers-reduced-motion`。

## 9. 运行与部署

```bash
npm run diagnosis:setup      # 幂等种子（不创建用户）
npm run diagnosis:server     # http://127.0.0.1:3100/diagnosis
```

- 空库首次打开走 Miniclaw setup 向导创建管理员。
- 默认 `fixture` 模型 + `mock` 数据；`live` 需要 `.env.diagnosis` 配置。
- 端口冲突时用 `DIAGNOSIS_PORT` 选择空闲端口，不杀占用者。
- 控制执行在所有模式下为 `disabled`。
