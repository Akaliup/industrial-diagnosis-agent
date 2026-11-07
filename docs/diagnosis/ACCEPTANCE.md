# 验收报告（ACCEPTANCE）

验收日期：2026-11-08
项目位置：`E:\工业诊断\industrial-diagnosis-agent`
基线提交：`fec1d5af9459fd91f23e5ab8f0f5d41b91440754`（历史重写后）
初次交付提交：`443136b`
审计补修提交：`fd88584`（重写后）
公开仓库历史清理：`interview-prep/` 已从所有提交移除，见 `BASELINE.md` §9
本轮分支：`feat/real-agent-eval`（真实 Agent 评测、逐次模型调用审计、CI 脚本权限修复）

## 1. 状态结论

| 维度     | 状态                          | 说明                                                                                                                                                                                                                                          |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工程版   | **PASS（附平台限制）**        | 诊断协议、工具网关、五阶段编排、预算、报告校验、知识检索、审批边界、UI、Eval、Trace replay、E2E、构建均通过；根测试的失败仍限定在 Windows 平台用例                                                                                            |
| 真实模型 | **PASS（集成）/ 质量见 §6.1、§6.2** | 已用已授权 DeepSeek 兼容端点完成 10 例 dev 试点（10/10）和全量 50 例（23/50，dev 14/29、holdout 9/21）；Phase 3 独立 10 例中，最后一次完整尝试为 6/10（最终修复前），修复后的机械/多故障定向复验通过；最终 10 例复验因 HTTP 402 余额不足为 `NOT_RUN`。未把分数外推为企业现场精度。Key 只存在本机 `.env.diagnosis`，未写入 Trace/报告/前端 |
| 企业接入 | **UNCONFIGURED**              | SCADA/MES/工单/RootCloud 均无企业文档、地址、账号或授权；本地假 REST 只验证配置链路                                                                                                                                                           |
| 控制执行 | **DISABLED**                  | 所有模式 `control_execution: disabled`；审批只确认建议意图，不执行设备控制                                                                                                                                                                    |

本报告记录审计补修 R1–R6 与四项残余风险检查的实际代码、测试与命令结果。
Fixture 分数只代表工程回归，不代表真实模型精度。

## 2. 启动与访问

```bash
npm run diagnosis:setup
npm run diagnosis:server
```

- 访问：`http://127.0.0.1:3100/diagnosis`
- 模式：`fixture` 模型 + `mock` 数据
- 空库：打开页面走原有 setup 向导创建管理员
- 本机演示库已有 `demo` 管理员；密码仅用于本机演示，不写入源码/部署模板
- 端口冲突：设置 `DIAGNOSIS_PORT`，不要终止占用进程

## 3. 审计补修（R1–R6）

| 编号 | 问题                                                  | 修复                                                                                                                                                                                                                                                                                                                                 | 回归测试                                                                                                            | 结果 |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---- |
| R1   | 报告引用未校验手册版本/撤回状态；错误版本可能污染结论 | 报告校验器接收文档视图，校验文档登记、版本、撤回、生效日期；证据快照记录 `manual_document_id`/`manual_version`；检索排除数据库中已撤回文档；假设状态/支持/反证漂移校验；兜底报告标记 `kind: safety`                                                                                                                                  | `report-validator.test.ts`、`orchestrator.test.ts`（撤回主手册）、`diagnosis-api.spec.ts`（错误版本不污染有效 Run） | PASS |
| R2   | 重试与模型调用可能绕过累计预算                        | 模型调用改为预留/结算式额度；重试与多角色共享 `model_calls`、输入/输出 token、墙钟截止时间；工具超时取剩余墙钟与单次超时的较小值                                                                                                                                                                                                     | `budget.test.ts`、`worker.test.ts`、50 例 Eval 预算断言                                                             | PASS |
| R3   | Eval 把被策略拒绝的尝试计为已执行，分母不一致         | 区分“已执行”与“被阻止”：只有真正到达来源的调用进入执行指标；按适用用例计算分母并提供 `*_n`；阻断用例必须同时包含一次成功必需查询                                                                                                                                                                                                     | `eval-scorer.test.ts`、`eval-fixture-regression.test.ts`、`diagnosis:eval:gate`                                     | PASS |
| R4   | 多 Workspace 种子/文档主键冲突                        | 报警、文档、chunk 使用 Workspace 作用域的稳定 ID；重复种子幂等；旧全局报警 ID 在同 Workspace 幂等键下复用                                                                                                                                                                                                                            | `workspace-scope.test.ts`                                                                                           | PASS |
| R5   | CI/E2E 复用本地库或已启动服务，测试互相污染           | 新增 `diagnosis:e2e:server`：每次清空并重建 `work/diagnosis/e2e-data`，使用 `INDUSTRIAL_DIAGNOSIS_DATA_DIR`、独立端口 3199、本地假 REST 与固定测试密钥；诊断 Playwright 配置 `reuseExistingServer: false`；移动端配置忽略 `diagnosis/**`；CI 增加契约同步、类型检查、MCP 构建、诊断测试、50 例门禁、Trace replay、Web 构建与隔离 E2E | 诊断 E2E 6/6、移动端 E2E 9/9、CI 工作流                                                                             | PASS |
| R6   | `.env.diagnosis` 未加载或错误配置静默生效             | 新增统一配置入口 `loadDiagnosisEnv`：shell 环境变量 > `.env.diagnosis` > 代码默认值；校验端口、模式、JSON、映射文件、模型 URL；`DIAGNOSIS_MODEL_MODE=live` 缺字段直接失败，不回退 Fixture                                                                                                                                            | `config-loader.test.ts`                                                                                             | PASS |

## 4. 四项残余风险

### 4.1 长模型调用期间的租约围栏

- `diagnosis_runs.lease_token` 单调递增；领取 Run 时 CAS 递增，释放后旧令牌不可复用。
- Run 状态、报告、假设、证据、工具调用回执均使用令牌围栏写入；续租/释放也校验 owner + token。
- 工具网关在每次派发前再次校验令牌；旧 Worker 无法在新 Worker 接管后写入。
- 回归：`worker.test.ts` 慢 Runner 双 Worker 接管；`crash-consistency.test.ts` 围栏回执。

### 4.2 真实 Trace replay，而不是 Fixture 重跑

- `replayTrace` 只消费已保存的 Trace：检查 Run/报告/证据作用域/引用/假设/事件序列，并用
  `evaluateCase` 重新打分；不启动 MCP、不调用模型。
- CLI：`npm run diagnosis:replay`，输出 `replayed=... inconsistent=... inference_calls=0 tool_calls=0`。
- 回归：`trace-replay.test.ts` 验证正常回放、引用篡改、评分篡改；Fixture 重跑已更名为
  `eval-fixture-regression.test.ts`，不再称为 replay。
- 本次实测：`replayed=50 inconsistent=0 inference_calls=0 tool_calls=0`。

### 4.3 来源配置 → 测试 → 状态 → Run 的真实路径

- `POST /api/diagnosis/sources/:id/test` 对 `live` 来源执行真实只读探测：读取
  `DIAGNOSIS_REST_BASE_URL`/`DIAGNOSIS_REST_TOKEN`，调用 resolve endpoint，校验返回设备映射；
  成功后才把来源状态改为 `configured`。
- `POST /runs` 在 `live` 模式下检查 `liveSourcesReady`；未配置来源返回 409，不回退 Mock。
- 通用 REST 适配器只读且不伪造证据；本地假服务返回设备映射但不返回证据时，Run 明确转人工。
- 回归：`live-source.test.ts`（本地 HTTP 假服务）、`diagnosis-api.spec.ts`（配置→测试→状态→Run）。
- 企业真实来源仍为 `UNCONFIGURED`，本地假服务不计入 `LIVE_VERIFIED`。

### 4.4 请求已发出但回执未落库；取消后的迟到结果

- 每次工具派发前先写入 `status='inflight'` 的工具调用日志；回执到达后更新同一行。
- 进程在请求与回执之间崩溃时，恢复执行先把遗留 `inflight` 标记为 `unknown`
  （`RECEIPT_UNKNOWN`），并写入 `tool.finished` 恢复事件；既不当作成功，也不当作未执行。
- 证据使用确定性 ID，重新检索会去重；检查点保证阶段可重入，不会重复推进结论。
- 取消/中止后到达的成功回执只用于关闭日志，状态记为 `cancelled`，不写证据、不进入重复调用
  缓存；数据库已取消但信号未传播时同样丢弃。
- 回归：`crash-consistency.test.ts` 五项测试（崩溃遗留行、派发前日志、传输层派发后异常、
  abort 后迟到成功、数据库取消后迟到成功）。

## 5. 实测命令与结果

| 命令                            | 时间  | 退出码 | 结果 / 产物                                                                                          |
| ------------------------------- | ----- | ------ | ---------------------------------------------------------------------------------------------------- |
| `npm run diagnosis:check`       | 19:20 | 0      | 19 文件 / 92 测试通过（`check-final-fix.log`）                                                       |
| `npm run diagnosis:eval:gate`   | 19:20 | 0      | 50/50，门禁 `ok=true`（`eval-gate-final-fix.log`）                                                   |
| `npm run diagnosis:replay`      | 19:21 | 0      | `replayed=50 inconsistent=0 inference_calls=0 tool_calls=0`（`replay-final-fix.log`）                |
| `npm run diagnosis:smoke`       | 19:21 | 0      | 六工具 MCP + pipeline 通过（`smoke-final-fix.log`）                                                  |
| `npm run diagnosis:demo`        | 19:21 | 0      | 5 场景 `failures=0`（`demo-final-fix.log`）                                                          |
| `npm run build`                 | 19:21 | 0      | 根 TypeScript 构建（`build-root-final-fix.log`）                                                     |
| `npm run build:web`             | 19:22 | 0      | `web/dist`（含 `diagnosis.html`，`build-web-final-fix.log`）                                         |
| `npm run diagnosis:build:mcp`   | 19:22 | 0      | MCP `dist/server.js`（`build-mcp-final-fix.log`）                                                    |
| Web `npx tsc --noEmit`          | 19:22 | 0      | Web 类型检查（`web-typecheck-final-fix.log`）                                                        |
| MCP `npm run typecheck`         | 19:22 | 0      | MCP 类型检查（`mcp-typecheck-final-fix.log`）                                                        |
| `npm run diagnosis:e2e`         | 19:23 | 0      | 6/6 通过，31.4s，隔离库 + 本地假 REST（`e2e-diagnosis-final-fix.log`）                               |
| `npm --prefix web run test:e2e` | 19:24 | 0      | 9/9 通过，39.0s（`e2e-mobile-final-fix.log`）                                                        |
| `npm run docs:check`            | 19:06 | 0      | Markdown 链接/格式检查                                                                               |
| `git diff --check`              | 19:06 | 0      | 无空白错误                                                                                           |
| `npm test -- --run`             | 19:24 | 1      | 353 文件：321 通过 / 32 失败；2968 测试：2887 通过 / 58 失败 / 23 跳过（`root-tests-final-fix.log`） |

### 5.1 根测试失败对照

同一台 Windows 11、Node 24.16.0、npm 11.13.0 环境下：

| 运行               | 测试文件 | 测试 | 失败文件 | 失败测试 | 跳过 |
| ------------------ | -------- | ---- | -------- | -------- | ---- |
| 基线 `fec1d5a`     | 334      | 2744 | 54       | 71       | 23   |
| 初次交付 `443136b` | 346      | 2931 | 32       | 58       | 23   |
| 本次补修           | 353      | 2968 | 32       | 58       | 23   |
| 产品标识统一后     | 353      | 2969 | 31       | 57       | 23   |

- 本次比初次交付多 7 个文件 / 37 个测试，正好对应诊断测试从 12 文件 / 55 测试增加到
  19 文件 / 92 测试。
- 逐条比较 `FAIL` 名称：两次运行都是 72 条失败记录（含同一文件的多个失败），名称集合完全
  相同，没有新增、消失或改名。
- 失败仍集中在 Windows 符号链接 `EPERM`、POSIX 路径假设、`tar`/含冒号路径、进程树终止、
  CardKit/streaming 环境缺失；诊断套件不依赖这些用例。
- 未修改基线断言、未放宽阈值、未删除测试。

失败名称清单：`work/diagnosis/logs/root-tests-final-fix-names.txt`；完整日志：
`work/diagnosis/logs/root-tests-final-fix.log`。

### 5.2 产品标识统一后复验（23:44–23:54）

产品标识统一为“工业诊断 Agent”后，按同一命令集复验；`LICENSE` 保留上游 MIT 版权声明。

| 命令                                                                 | 退出码 | 结果                                                                   |
| -------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `npm run docs:check`                                                 | 0      | Markdown 链接/格式检查通过                                             |
| `git diff --check`                                                   | 0      | 无空白错误                                                             |
| `npm run diagnosis:check`                                            | 0      | 19 文件 / 92 测试通过                                                  |
| `npm run build` / `build:web` / `diagnosis:build:mcp` / runner build | 0      | 全部构建通过                                                           |
| `npm run desktop:typecheck` / `desktop:build`                        | 0      | 通过                                                                   |
| `npm run diagnosis:eval:gate`                                        | 0      | 50/50，当时 `live_eval=NOT_RUN`（尚未配置真实模型）                    |
| `npm run diagnosis:replay`                                           | 0      | `replayed=50 inconsistent=0 inference_calls=0 tool_calls=0`            |
| `npm run diagnosis:smoke`                                            | 0      | 六工具 MCP + pipeline 通过                                             |
| `npm run diagnosis:e2e`                                              | 0      | 6/6 通过，27.3s                                                        |
| `npm --prefix web run test:e2e`                                      | 0      | 9/9 通过，34.8s                                                        |
| `npm test -- --run`                                                  | 1      | 353 文件：322 通过 / 31 失败；2969 测试：2889 通过 / 57 失败 / 23 跳过 |

与 §5.1 基线逐条比较，失败名称集合没有新增；`frontend-product-terminology` 的旧失败已随
文档更新消失。失败仍集中在 Windows 符号链接 `EPERM`、POSIX 路径假设、`tar`/含冒号路径、
进程树终止和 CardKit/streaming 环境差异。未修改断言、阈值或测试集。

日志：`work/diagnosis/logs/identity-verify-build.log`、
`work/diagnosis/logs/identity-verify-eval.log`、`work/diagnosis/logs/identity-e2e-diagnosis.log`、
`work/diagnosis/logs/identity-e2e-mobile.log`、`work/diagnosis/logs/root-tests-identity-final2.log`。

### 5.3 真实 Agent 评测改造复验（2026-11-08）

| 命令                                                           | 退出码 | 结果                                                                                                                                                            |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run diagnosis:sync-check`                                 | 0      | 契约一致，4 个生成产物                                                                                                                                          |
| `npm run typecheck`                                            | 0      | 根 TypeScript 类型检查通过                                                                                                                                      |
| `npm run diagnosis:check`                                      | 0      | 21 文件 / 107 测试通过                                                                                                                                          |
| `npm run diagnosis:eval:gate`                                  | 0      | 50/50，门禁 `ok=true`；反证适用 23 例，Top-1 适用 40 例                                                                                                         |
| `npm run diagnosis:eval -- --mode live --split dev --limit 10` | 0      | 10/10 通过，全部指标 1.0；65 次模型调用，失败 0；mean 45.8s / p95 67.4s                                                                                         |
| `npm test -- --run`                                            | 1      | 354 文件：323 通过 / 31 失败；2978 测试：2898 通过 / 57 失败 / 23 跳过；失败仍为 §5.1 的 Windows 平台用例；诊断测试另见 `diagnosis:check`（21 文件 / 107 测试） |

本轮新增：逐次模型调用审计表 `diagnosis_model_calls`（模型、角色、阶段、token、延迟、
工具请求、失败原因、原始输出截断）、单例失败继续评测并保留 Trace、Top-1 / 工具选择准确率 /
转人工准确率 / 任务成功率 / 延迟 / token 指标，以及 23 个真正要求保留反证的 gold 用例。
与 §5.2 基线逐文件比较，当前 31 个失败文件没有新增；`frontend-product-terminology`
的旧失败已消失。失败仍集中在 Windows 符号链接 `EPERM`、POSIX 路径、进程树终止和
CardKit/streaming 环境差异；诊断测试另见 `diagnosis:check`（21 文件 / 107 测试全部通过）。

GitHub Actions 在 `7bc77df` 上两项工作流均通过：Diagnosis CI（run 42410313417）与
CI（run 42410313357）；最终提交 `8ea4006` 上再次通过：Diagnosis CI（run
42410992913）与 CI（run 42410993044）。此前 `7b02f24` 的 CI 因根测试先于诊断 MCP
安装/构建而失败，已由 `a2c467f` 修复并复验。

### 5.4 Phase 3 最终回归（2026-11-08）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run diagnosis:check` | 0 | 22 文件 / 120 测试通过；契约 hash 一致 |
| `npm run diagnosis:eval:gate` | 0 | 50/50，门禁 `ok=true` |
| `npm run diagnosis:replay` | 0 | `replayed=50 inconsistent=0 inference_calls=0 tool_calls=0` |
| `npm run diagnosis:smoke` | 0 | 五阶段流水线 + MCP 工具 smoke 通过 |
| `npm run diagnosis:e2e` | 1 → 0 | 默认浏览器 revision 缺失时 6 failed；使用已安装 Chromium 1248 的 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 后 6/6 PASS |
| `npm run build` | 0 | 根 TypeScript 构建通过 |
| `npm run build:web` | 0 | Vite 构建通过（仅 chunk 体积警告） |
| `npm run diagnosis:build:mcp` | 0 | MCP 包构建通过 |
| `npm test -- --run` | 1 | 356 文件：325 通过 / 31 失败；2997 测试：2917 通过 / 57 失败 / 23 跳过；失败均为 §5.1 的 Windows 平台用例，未新增诊断失败 |
| Phase 3 Fixture（10 例） | 0 | 10/10 PASS；多故障 coverage/precision 1.0（非真实模型） |
| Phase 3 定向真实模型 | 0 | 机械 2/2、`mul-align-lube` 1/1、`mul-bearing-drift` 1/1 |
| Phase 3 完整真实模型 `full-2` | 1 | 6/10（最终三项修复前）；多故障 coverage 0.833 / precision 1.0 |
| Phase 3 最终 10 例真实复验 | 2 | `NOT_RUN`：第一次模型调用 HTTP 402，余额不足，按预算约束停止 |

安全与恢复定向测试：`workspace-scope`、`report-validator`、`policy`、`tool-gateway`、
`crash-consistency`、`worker`、`live-role-runner`、`approvals`、`repeat-guard`、
`mcp-client` 共 52 测试通过。覆盖跨 Workspace 越权、不适用手册引用、伪造引用、高风险控制
阻断、自审批禁止、Worker 崩溃恢复、重复工具调用、取消后迟到回执、Provider 空响应/非法 JSON
与 MCP 连接失败。

## 6. 50 例 Fixture Eval

产物：`work/diagnosis/eval/<eval_run_id>/report.md` 与 `summary.json`。
本轮实测（`diagnosis:eval:gate`，2026-11-08）：

| 指标                      | 值                                                |
| ------------------------- | ------------------------------------------------- |
| total / passed            | 50 / 50                                           |
| citation_integrity        | 1.0                                               |
| unauthorized_calls        | 0                                                 |
| blocked_attempts          | 0                                                 |
| missed_handoff            | 0                                                 |
| counter_evidence_retained | 1.0（适用 23 例，分母 23）                        |
| evidence_coverage         | 1.0（分母 49）                                    |
| required_tool_recall      | 1.0（分母 69）                                    |
| tool_selection_accuracy   | 1.0（分母 69）                                    |
| solvable_completion       | 1.0                                               |
| handoff_accuracy          | 1.0                                               |
| task_success_rate         | 1.0                                               |
| unnecessary_handoff       | 0                                                 |
| top1_hit                  | 1.0（适用 40 例）                                 |
| top3_hit                  | 1.0（适用 40 例）                                 |
| multi_fault_coverage      | 1.0（适用 10 例）                                 |
| multi_fault_precision     | 1.0                                               |
| mean / p95 latency        | 539 ms / 2919 ms                                  |
| model_calls               | 326（失败 0）                                     |
| tokens                    | 1,914,985 in / 188,942 out / 2,103,927 total      |
| estimated_cost_usd        | n/a（未配置单价，不能冒充账单）                   |
| threshold_check           | ok，failures=[]                                   |
| live_eval                 | `NOT_RUN`（本表是 Fixture 门禁；真实模型见 §6.1） |

分类：FA 10、INS 10、MEC 10、MUL 10、SEN 10；dev 29、holdout 21。
`counter_evidence_n=23` 来自 SEN-01..03、MEC-01..10、FA-01..10 的
`required_contradictions`：这些用例的 Fixture 推理会生成一个被反驳的竞争假设，
评分要求报告保留对应的振动证据。`evidence_coverage`、`required_tool_recall` 与
`tool_selection_accuracy` 按必证项/必需工具/必需+禁用工具条数做微平均，而不是把
1 条和 5 条的用例等权平均；零分母指标在门禁中跳过并显示 N/A。
Fixture 的 token 是估算值，不是供应商账单；真实 token 只在 Live Eval 的
`diagnosis_model_calls` 中记录。

### 6.1 真实模型 Live Eval（DeepSeek 兼容端点）

配置：`DIAGNOSIS_LLM_BASE_URL=https://api.deepseek.com/v1`、`DIAGNOSIS_LLM_MODEL=deepseek-chat`；
供应商实际返回的 `model` 主要是 `deepseek-flash`；full-02 中 10 次失败调用返回
`deepseek-chat`（空响应或非法 JSON），审计表按响应记录真实模型名。Key 仅保存在
本机 `.env.diagnosis`（已被 `.gitignore` 忽略），没有写入 Trace、报告、前端或 Git。
错误路径由 `tests/diagnosis/live-role-runner.test.ts` 覆盖：429/5xx 重试至 3 次、401
不重试、空 200 响应保留原始 body、非法 JSON 不盲目重试、`max_tokens` 透传。

先跑 10 例 dev 试点，分析失败并修正提示与编排语义，再跑全量。最终试点
（`work/diagnosis/live-pilot-15`）结果：

| 指标                      | 值                                      |
| ------------------------- | --------------------------------------- |
| total / passed            | 10 / 10                                 |
| top1_hit / top3_hit       | 1.0 / 1.0（10 例）                      |
| evidence_coverage         | 1.0（分母 7）                           |
| citation_integrity        | 1.0                                     |
| tool_selection_accuracy   | 1.0（分母 13）                          |
| counter_evidence_retained | 1.0（分母 6）                           |
| handoff_accuracy          | 1.0                                     |
| task_success_rate         | 1.0                                     |
| unauthorized_calls        | 0                                       |
| mean / p95 latency        | 45,780 ms / 67,370 ms                   |
| model_calls               | 65（失败 0）                            |
| tokens                    | 423,238 in / 62,646 out / 485,884 total |
| estimated_cost_usd        | n/a（未配置单价，不能冒充账单）         |

动态补查证据：MEC-05 的 `generate_hypotheses` 先检索手册；`hypothesis_verifier` 基于
手册结果请求 MES 事件与历史案例；`verify_evidence` 第二轮又更换 telemetry 时间窗并检索
振动频谱。查询由模型在上一轮工具结果之后生成，不是固定脚本；完整工具序列见
`docs/diagnosis/artifacts/live-samples/MEC-05.json`。

试点中真实暴露并修复的问题（均有 Trace 与回归测试）：

1. 模型自造工具参数名导致 `schema_invalid`：把每个角色的工具 JSON Schema 注入系统提示。
2. 空 200 响应被当作不可重试：改为读取原始 body、记录 `{status, body}`、允许有界重试。
3. 报告 JSON 被 8,000 输出 token 截断：提升到 12,000，并为报告阶段预留 3,000；
   全量 50 例又发现 3,000 仍会截断长报告（MEC-03、MUL-01、MUL-08），报告阶段预留与
   单次上限提升到 4,500，并用这三个用例复验（见 §6.1.1）。
4. 有 supported 根因时仍因 `insufficient_evidence` 转人工：只有无确定性根因才 handoff。
5. 模型声明的 hypothesis status 被忽略：`HypothesisDraftSchema` 增加可选 `status`。
6. 撤回手册仍被翻译/参考片段替代：上下文标注撤回状态，报告校验拒绝非适用版本引用，
   并在 `conclusion_status=insufficient_evidence` 与 supported 根因并存时报错。
7. 模型自拟 `handoff_reason` 把正常结论标成转人工：有 supported 结论时清空该字段。
8. 误报子类混淆（comm / recovered / threshold / time）：把鉴别优先级写入提示，并要求
   反驳机械故障时引用 `vibration_rms` 的 `telemetry_series` 证据本身。

提示只包含根因码的通用鉴别条件和工具 Schema，不包含 `case_id`、gold 根因或按用例
硬编码的分支；模型上下文仍由当前 Run 的设备、证据和手册组成，评分由独立 gold 文件驱动。
失败样本的输入、模型调用、工具轨迹、报告、评分原因与摘要保存在
`docs/diagnosis/artifacts/live-failures/`，最终通过批次的摘要保存在同一目录的
`pilot-15-summary.json`。

全量 50 例（dev 29 + holdout 21）实际执行过两次：

- `work/diagnosis/live-full-01`（04:08–04:11）：50 例全部执行，但评测期间本地 MCP 构建
  重写 `dist/server.js`，FA-07 起 44 例在首个工具调用即报 `MCP error -32000: Connection closed`，
  最终 5/50。该批次是评测环境干扰，不作为模型质量结论；summary 与代表性 Trace 保存在
  `docs/diagnosis/artifacts/live-failures/`。
- `work/diagnosis/live-full-02`（04:28–05:05）：在稳定 MCP 构建上重跑全量 50 例。该批次
  使用修复前的 3,000 报告输出上限，MEC-03/MUL-01/MUL-08 因报告 JSON 截断记 `NO_REPORT`；
  其余失败是真实模型诊断结论问题。

| 指标                                  | 全量 50                         | dev 29             | holdout 21         |
| ------------------------------------- | ------------------------------- | ------------------ | ------------------ |
| total / passed                        | 50 / 23                         | 29 / 14            | 21 / 9             |
| top1_hit / top3_hit                   | 0.60 / 0.60 (n=40)              | 0.625 (n=24)       | 0.563 (n=16)       |
| evidence_coverage                     | 0.878 (n=49)                    | 0.871 (n=31)       | 0.889 (n=18)       |
| citation_integrity                    | 0.90                            | 0.931              | 0.857              |
| tool_selection_accuracy               | 0.971 (n=69)                    | 0.953 (n=43)       | 1.0 (n=26)         |
| counter_evidence_retained             | 0.826 (n=23)                    | 0.786 (n=14)       | 0.889 (n=9)        |
| handoff_accuracy                      | 0.78                            | 0.793              | 0.762              |
| task_success_rate                     | 0.46                            | 0.483              | 0.429              |
| multi_fault_coverage / precision      | 0.20 / 0.40 (n=10)              | 0.30 / 0.60 (n=5)  | 0.10 / 0.20 (n=5)  |
| unauthorized_calls / blocked_attempts | 0 / 9                           | 0 / 6              | 0 / 3              |
| model_calls                           | 337（失败 10）                  | 194（失败 6）      | 143（失败 4）      |
| tokens（in / out / total）            | 2,380,307 / 356,633 / 2,736,940 | 1,568,545          | 1,168,395          |
| mean / p95 latency                    | 44,563 / 67,673 ms              | 44,824 / 69,178 ms | 44,202 / 65,160 ms |
| estimated_cost_usd                    | n/a（未配置单价）               | n/a                | n/a                |

按类别通过：FA 7/10、INS 9/10、MEC 5/10、MUL 0/10、SEN 2/10。27 个失败用例的完整
Trace、输入、模型调用、工具轨迹、报告与评分原因保存在
`docs/diagnosis/artifacts/live-failures/full-02-*.json`，汇总为 `full-02-summary.json`。

失败分类（真实模型行为）：

1. **机械故障鉴别不足**（MEC-06/07/08/09、MUL-05/06）：模型很少生成 `misalignment` 或
   `lubrication` 假设，或生成后判为 inconclusive，最终落到 `bearing_wear` 或
   `insufficient_evidence`。例如 MEC-07 只生成 bearing_wear、false_alarm_threshold、
   sensor_drift 三个假设，没有 misalignment。
2. **多故障覆盖**（MUL-01..10 全部失败）：模型倾向只输出一个主根因，漏掉同时存在的
   `sensor_drift`/`false_alarm_comm`；MUL-02 把“多故障”写成单个 `multi_fault` 假设，
   而不是两个独立根因；`multi_fault_coverage=0.20`。
3. **传感器异常子类**（SEN-01/02/03/06/07/08/09/10）：`sensor_drift`、`sensor_range`、
   `sensor_stuck`、`sampling_gap` 互相混淆；证据不足时倾向 `insufficient_evidence` 并
   多余转人工（`unnecessary_handoff=11`）。
4. **反证保留不足**（FA-05、MEC-06）：结论接近正确，但未引用 `vibration_rms` 反证；
   `counter_evidence_retained=0.826`。
5. **执行与工程问题**（FA-01、MEC-03、MUL-01、MUL-08、MUL-10）：FA-01 是外部端点空响应
   （`EXECUTION_ERROR`，不计作模型诊断错误）；MEC-03/MUL-01/MUL-08 是报告 JSON 在 3,000
   输出 token 处截断（已修复，见 §6.1.1）；MUL-10 是模型报告把 supported 假设写成
   inconclusive，被 `HYPOTHESIS_STATUS_DRIFT` 校验拒绝，校验器按预期工作。

`live-full-02` 的 23/50 使用修复前的报告预算，是下界；不把 3 个截断用例事后改判为通过，
也不重新计算通过率。按 Fixture 门禁阈值检查该批次会失败（pass_rate、citation_integrity、
evidence_coverage、top3_hit、counter_evidence_retained、unnecessary_handoff），这正是
真实模型与 Fixture 的差距，不能把 Fixture 阈值当作真实模型质量结论。

### 6.1.1 报告输出预算修复复验

`REPORT_OUTPUT_RESERVE` 与报告单次输出上限从 3,000 提升到 4,500 后，用 full-02 中三个
`NO_REPORT` 用例在稳定 MCP 构建上重跑（`work/diagnosis/targeted-report-budget-out`）：

| 用例   | full-02（上限 3,000）                     | 复验（上限 4,500）                                                                |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| MEC-03 | `NO_REPORT`（JSON 在第 6,098 字符处截断） | **PASS**                                                                          |
| MUL-01 | `NO_REPORT`（JSON 截断）                  | 报告生成成功；根因仍错（`multi_fault`，期望 bearing_wear\|sensor_drift）          |
| MUL-08 | `NO_REPORT`（JSON 截断）                  | 报告生成成功；根因仍错（`false_alarm_comm`，期望 bearing_wear\|false_alarm_comm） |

结论：截断是工程缺陷，已修复并由 3 例复验；MUL-01/MUL-08 的剩余失败是多故障推理缺陷，
不能归因于报告预算。复验 Trace 保存在
`docs/diagnosis/artifacts/live-failures/targeted-budget-*.json`。

失败用例与评分原因保存在 `docs/diagnosis/artifacts/live-failures/`；空响应/超时标记为执行
错误，重试上限 3 次，不把外部故障算作模型诊断错误。Holdout 用例包含在全量运行中，不单独
声称 holdout-only 精度。

### 6.2 Phase 3 独立 10 例复验

评测集：`evals/diagnosis-phase3/`（2 机械、3 多故障、2 传感器、3 负例/数据不足），
与原始 50 例分开，gold 不进入模型上下文。产物与逐例 Trace 见
`docs/diagnosis/artifacts/phase3-live/`。

| 运行 | 范围 | 结果 | 说明 |
| --- | --- | --- | --- |
| Fixture 回归 | 10 例 | **10/10 PASS** | 只证明回归，不是真实模型结果 |
| `targeted-1` | `mec-align`、`mec-lube` | **2/2 PASS** | 机械鉴别；57.1s、14 次调用、147,458 tokens |
| `targeted-5` | `mul-align-lube` | **1/1 PASS** | 多故障 coverage/precision 1.0 |
| `targeted-drift-4` | `mul-bearing-drift` | **1/1 PASS** | 预算恢复后；65.4s、7 次调用、76,299 tokens |
| `full-2` | 10 例完整尝试 | **6/10 PASS** | 最终三项修复前；42.5s、57 次调用、545,406 tokens；coverage 0.833 / precision 1.0 |
| 最终 10 例 | 10 例 | **NOT_RUN** | 第一次模型调用 HTTP 402；未继续付费请求 |

`full-2` 的 4 个失败：

1. `mul-bearing-drift`：验证修复调用耗尽报告预留，`execute` 无条件转人工
   （`UNNECESSARY_HANDOFF`）——已修复，定向 PASS；
2. `sen-gap`、`sen-range`：MCP 连接阶段异常穿透，Run 被标为 failed——已修复，
   `mcp-client.test.ts` 覆盖；真实模型复验 `NOT_RUN`；
3. `neg-single-sensor`：模型把持续温度趋势判为 `false_alarm_threshold`，`sensor_drift`
   降为 inconclusive——未解决，保留为失败样本。

结论边界：不能把 `full-2` 的 6/10 表述为最终代码的 10 例结果；最终完整复验因余额不足
未运行。三项修复分别有单测和定向真实模型 PASS，但不能外推为企业现场精度。

## 7. E2E 与截图

诊断 E2E（隔离数据目录，端口 3199）：

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="C:/Users/lz/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe" \
  npm run diagnosis:e2e
```

结果：6 passed（主链路、人工复核、Webhook 幂等/跨 Workspace、错误手册版本、live 来源、
取消后刷新恢复）。

移动端 E2E（与诊断隔离）：

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/work/diagnosis/pw-browsers" \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="C:/Users/lz/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe" \
  npm --prefix web run test:e2e
```

结果：9 passed。本机 Playwright 1.62.1 期望 ffmpeg revision 1011，已安装的是 1013；
本次把现有 ffmpeg 复制到项目内 `work/diagnosis/pw-browsers/ffmpeg-1011` 后运行，
没有修改全局 Playwright 缓存，也没有下载外部二进制。CI 使用标准安装时不需要该临时目录。

截图：

```text
docs/diagnosis/screenshots/inbox-1440x900.png
docs/diagnosis/screenshots/workbench-1440x900.png
docs/diagnosis/screenshots/evidence-drawer-1440x900.png
docs/diagnosis/screenshots/reviews-1440x900.png
docs/diagnosis/screenshots/eval-1440x900.png
docs/diagnosis/screenshots/inbox-1024x768.png
docs/diagnosis/screenshots/mobile-nav-390x844.png
docs/diagnosis/screenshots/review-submitted-1440x900.png
```

## 8. Fresh data 演示

在独立项目副本（`work/diagnosis/fresh-demo`，已清理）中从空数据目录执行：

1. `npx tsx scripts/diagnosis/setup.ts` → exit 0，5 条模拟报警；
2. `DIAGNOSIS_PORT=3200 npx tsx src/diagnosis/server.ts` → health 200；
3. `POST /api/auth/setup` 创建管理员 → 201；
4. 从 `demo-sensor-drift` 报警创建 Run → `awaiting_human`；
5. 报告结论 `sensor_drift: supported`、`bearing_wear: contradicted`，校验 `valid=true`；
6. Markdown 导出 4043 bytes。

产物：`docs/diagnosis/artifacts/fresh-demo-report.md`；日志：
`work/diagnosis/logs/fresh-setup.log`、`fresh-server.log`。

## 9. 本机 live 检查

| 检查               | 结果                                                                |
| ------------------ | ------------------------------------------------------------------- |
| 登录 / 会话 Cookie | demo 用户登录成功                                                   |
| 取消 Run           | `202 cancelled=true`，事件 `run.created,tool.started,run.cancelled` |
| 续诊               | 从拒绝复核的 Run 创建新 Run，进入 `awaiting_human`                  |
| WebSocket          | 52 个事件 seq 单调；`after_seq` 补拉无缺口                          |
| Webhook            | 合法签名 201、重复 200 同 ID、错误签名 401、未配置来源 503          |
| 自审批             | 高风险控制建议申请人自批 → 403 `SELF_APPROVAL_FORBIDDEN`            |
| 文档预览           | Markdown `text/markdown` 200；PDF `application/pdf` 200             |
| 报告导出           | Markdown/HTML 可打开；复核后显示 `accepted` / `engineer_confirmed`  |

## 10. 报告与产物

```text
docs/diagnosis/artifacts/demo-report-reviewed.md
docs/diagnosis/artifacts/demo-report-reviewed.html
docs/diagnosis/artifacts/fresh-demo-report.md
docs/diagnosis/screenshots/
work/diagnosis/eval/eval_mw6barmy_all/
work/diagnosis/logs/
```

## 11. 未完成 / 外部条件

1. **真实模型**：已有本机授权的 DeepSeek 兼容端点，完成 10 例 dev 试点（10/10）与全量
   50 例（23/50，dev 14/29、holdout 9/21）；Phase 3 完整尝试 6/10（最终修复前），
   修复后的定向复验通过；最终 10 例复验因 HTTP 402 为 `NOT_RUN`。全量失败类别与 Trace
   见 §6.1、§6.2，不把分数声明为企业现场准确率。生产级密钥托管、配额/限流与数据合规
   仍未配置。
2. **企业来源**：SCADA、MES、工单、RootCloud 均缺接口文档、地址、认证、字段样例、
   资产映射、时区/单位/限流说明和只读测试账号；状态 `UNCONFIGURED`。
3. **Docker/Container**：未验证容器隔离与容器内 Runner；本版使用 Host 本地运行。
4. **Electron 安装包**：typecheck/build 通过，但无签名证书，未制作安装器。
5. **Windows 根测试**：平台相关失败见 §5.1；未修改基线断言或放宽阈值。
6. **format:check 脚本**：Windows `.bin` shim 兼容问题；已用 `npx prettier --check` 验证
   本次代码格式。

## 12. 结论

工程版可以本地启动、从报警跑到带引用报告、复核、审批、Eval、真实 Trace replay 与导出；
R1–R6 与四项残余风险均有代码、自动化测试和实测命令支撑。真实模型链路已用授权
DeepSeek 兼容端点跑通 10 例 dev 试点（10/10）和全量 50 例（23/50）；Phase 3 新增了
独立 10 例、异常清单、多故障独立根因、传感器/机械鉴别、预算恢复与 MCP 重连，机械与
多故障定向复验通过。最终 10 例完整复验因 HTTP 402 为 `NOT_RUN`，`neg-single-sensor`
的阈值误报仍暴露模型推理差距；这些结果均如实记录，不声明企业现场精度。企业实时接入、
生产级模型配额与数据合规、容器隔离和签名安装包仍需外部条件，未计入工程版 PASS。
