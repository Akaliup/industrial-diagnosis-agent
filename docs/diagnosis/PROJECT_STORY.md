# 项目说明（PROJECT STORY）

## 1. 我做了什么

在 Miniclaw 1.0.0 的自托管 Agent 工作台上，新增了一条**设备报警后的故障诊断链路**：

```text
报警 → 统一设备查询 → 状态确认 → 异常定位 → 假设生成 → 证据验证 → 引用报告 → 人工复核
```

核心工作不是改产品名或做静态页面，而是：

1. **领域协议与工具边界**：在 `src/diagnosis/contracts/domain.ts` 定义 Run、阶段、证据、
   假设、报告、Tool 输入输出和错误码；用 `sync-contracts` 生成 MCP 子包与 Web 的副本，
   并用 hash 清单防止三处漂移。
2. **只读 MCP 工具**：新增 `packages/industrial-diagnosis-mcp/`，通过 stdio JSON-RPC 提供
   设备解析、状态/时序/报警/MES/工单查询、手册检索、手册页、案例检索、证据读取六个工具。
   mock/replay 使用本地 fixture store；live 支持配置固定的通用 REST adapter；根云 adapter
   在没有接口文档、签名和账号时明确返回 `UNCONFIGURED`。
3. **PolicyGateway 与 RoleRunner**：没有恢复 Miniclaw 的通用 Agent 工具权限，而是为诊断
   单独实现网关：角色白名单、严格 Zod Schema、设备作用域、风险、预算、重复调用守卫、
   证据入库。四个逻辑角色由结构化 RoleRunner 执行，不依赖 Subagent 结果 RPC。
4. **五阶段 Harness**：实现 `confirm_status → locate_anomaly → generate_hypotheses →
   verify_evidence → produce_report`，带轮次/工具/模型/墙钟预算、证据缺口转人工、
   checkpoint、Worker 租约与崩溃恢复。
5. **可核查报告**：证据 ID 在入库时按 Workspace/Run/来源/记录/payload hash 确定性重算；
   报告校验器逐条检查引用存在性、设备/时间/机型/手册版本/payload hash、支持与反证关系、
   控制执行禁用与 Mock/Fixture 免责声明。
6. **产品工作台**：在 `web/src/diagnosis/` 实现报警收件箱、发起诊断、五阶段工作台、
   证据抽屉、设备台账、来源与知识、复核审批、评测回放；白底/黑字/蓝色强调，Lucide 图标，
   进入/过渡/退出动效，支持 reduced-motion 与三种尺寸。
7. **Eval 与回归**：构造 50 个独立场景（FA/INS/MEC/MUL/SEN，29 dev + 21 holdout），
   输出引用完整性、证据覆盖、必需工具召回、可解完成率、不必要转人工、Top-3、多故障覆盖等
   指标；提供 Trace 回放、CI 门禁和 Playwright E2E。

## 2. 实测结果（只写实际跑过的）

| 项目 | 结果 |
| --- | --- |
| 诊断测试 | 12 个文件、55 个测试全部通过 |
| Fixture Eval | 50/50 通过，引用完整性 1.0，未授权调用 0，可解完成率 1.0，不必要转人工 0 |
| E2E | 2 项通过：桌面/平板/移动主链路 + 人工复核锁定 |
| 构建 | 根 `tsc`、Web Vite、MCP `tsc` 全部 exit 0 |
| 类型检查 | 根、Web、MCP、Electron 全部 exit 0 |
| 其他 | MCP/pipeline smoke、demo smoke、fresh data 演示、WebSocket 补拉、Webhook 签名/幂等均实测通过 |

**不声明**：真实模型准确率、真实企业接入、现场诊断收益、已投产运行。Fixture Eval 只证明
协议、工具、证据、报告和回放工程链路；Live Eval 在无授权 Provider 时为 `NOT_RUN`。

## 3. 关键难点与处理

- **中文检索召回**：无空格长词既不是 FTS token，`LIKE` 也匹配不到连续原文。实现双字窗口
  回退，并保留机型/版本过滤；扫描 PDF 返回 `OCR_REQUIRED`，不把空文本当索引。
- **证据可信度**：模型可能伪造 ID 或跨 Run 引用。证据 ID 在网关入库时重算，报告校验器
  以入库记录为准，不信任角色输出。
- **重复与重试**：连续相同调用拒绝，非连续相同调用复用缓存成功；失败不缓存。重试与
  重复守卫分离，避免“重试被误判为重复”。
- **崩溃恢复**：Worker 使用数据库租约 + CAS claim；过期租约可被接管，活跃租约不被抢占；
  两个 Worker 对同一 queued Run 只执行一次。测试发现 Worker 先 claim 再调用 orchestrator
  会漏发 `run.started`，已补发且避免续跑重复。
- **复核状态**：报告生成时的 `review_status` 是快照；复核后以 Run 当前状态覆盖报告导出，
  避免“已复核但导出仍显示 pending”。

## 4. 开源复用边界

- 基线：Miniclaw 1.0.0，MIT；保留 LICENSE、lockfile、原有入口与依赖。
- 参考：Craft Agents 0.11.4，Apache-2.0；只参考信息层级、步骤条、证据抽屉、复核队列等
  交互模式，未迁移其 Bun workspace、账号、Electron IPC 或会话服务，未复制源码。
- 新增诊断代码、MCP 子包、Web 页面、fixture、Eval 与测试为本任务编写；依赖均为项目局部
  安装，未做全局升级。

## 5. 适用边界

这是一个可运行的**工程版诊断工作台**：能在 Mock/Fixture 下完整演示报警到报告、引用、复核、
审批和 Eval。它需要企业提供只读接口文档、账号和字段映射后才能接真实数据；需要授权模型
Provider 后才能做真实模型质量验收；控制执行始终禁用，审批只确认建议意图。
