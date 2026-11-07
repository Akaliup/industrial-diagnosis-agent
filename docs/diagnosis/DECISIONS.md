# 设计决策记录（DECISIONS）

记录本任务中影响架构、安全边界与验收方式的选择。编号仅用于引用，不代表优先级。

## ADR-001 诊断运行时与 Miniclaw 主服务同库、独立入口

**选择**：在 `src/diagnosis/` 建立独立诊断服务入口 `src/diagnosis/server.ts`，复用 Miniclaw
的 SQLite 数据库、用户会话与静态资源构建；诊断表前缀 `diagnosis_`，由
`src/diagnosis/db.ts` 以事务迁移创建。

**原因**：诊断需要与现有用户/Workspace/登录态一致，但不把通用 Agent 的工具权限带入诊断链路；
独立入口可以单独启动、测试和部署，不改变 `src/index.ts` 的生产聊天路径。

**替代方案**：把诊断路由直接挂到主 `src/web.ts`。缺点是启动耦合、测试需加载全部渠道服务，
且难以证明诊断工具边界独立。

**影响**：同一数据库需要迁移与备份策略；诊断服务只挂载 `/api/auth` 与 `/api/diagnosis`，
不暴露用户管理、渠道、计费等无关路由。

## ADR-002 只读 MCP 工具 + 独立 PolicyGateway

**选择**：诊断工具固定为六个：`equipment_resolve`、`equipment_query`、
`maintenance_search_manual`、`maintenance_get_manual_section`、`maintenance_search_cases`、
`evidence_get`。MCP 子包通过 stdio JSON-RPC 提供，主服务通过 `DiagnosisMcpClient` 调用。
每次调用先经过 `PolicyGateway`：认证上下文 → Workspace/Run 作用域 → 角色白名单 →
严格 Zod Schema → 设备范围 → 风险级别 → 预算 → 重复调用守卫 → 执行 → 证据入库。

**原因**：Miniclaw 生产 Runner 的通用工具权限不应被恢复或复用；诊断链路必须有可证明的
只读边界。工具白名单和 Schema 在网关内校验，不能靠 Prompt 或 UI 约束。

**替代方案**：复用通用 Agent 的 `runtime_policy.tools` 或直接让角色 Runner 调 MCP。
两者都会让 Bash/Write/任意 MCP 绕过边界，已拒绝。

**影响**：新增工具必须同时修改 `TOOL_POLICY`、MCP 服务、共享协议与测试；未知工具一律
`POLICY_DENIED`。

## ADR-003 四个逻辑角色，不是四个子代理进程

**选择**：`data_investigator`、`knowledge_retriever`、`hypothesis_verifier`、
`report_reviewer` 是结构化角色调用，由 `RoleRunner` 接口执行。Fixture 模式使用
`FixtureRoleRunner` 的确定性规则；Live 模式使用 OpenAI 兼容 Chat Completions 的
`LiveRoleRunner`。没有依赖未经验证的 Subagent 结果 RPC。

**原因**：角色分工需要的是“谁可以请求哪些工具、输出什么结构”，不是进程数。单进程结构化
调用更容易做预算、重放、错误修复和 Eval；也避免把 Miniclaw 的通用 Subagent 能力引入诊断。

**影响**：四个角色共享一个编排循环；角色输出必须通过 Zod 校验，失败可带修复问题重试一次。

## ADR-004 证据 ID 确定性重算，报告引用逐条校验

**选择**：证据入库时按
`ev_${sha256(workspace|run|source|source_record_id|payload_hash).slice(0,20)}`
重新计算 ID；报告校验器检查引用存在性、Workspace/Run/设备作用域、时间窗、机型、手册版本、
payload hash、支持/反证关系、控制执行字段与 Mock/Fixture 免责声明。

**原因**：模型或工具不能通过伪造 ID、跨 Run 引用、旧版手册或错误机型制造“有引用”的假象；
确定性 ID 也让重复调用与回放可复现。

**影响**：工具返回的 EvidenceDraft ID 不是最终真相，网关以入库结果为准；测试必须断言
`source_record_id`/payload，而不是只断言 ID 非空。

## ADR-005 五阶段编排、预算与转人工

**选择**：固定阶段序列
`confirm_status → locate_anomaly → generate_hypotheses → verify_evidence → produce_report`，
默认预算：8 轮、单阶段 3 轮、32 次逻辑工具调用、单次最多 3 次尝试、16 次模型调用、
300 秒墙钟、单次查询窗口最多 24 小时。证据不足、来源失败、无支持假设或报告校验失败时
进入 `awaiting_human`，保留 `handoff_reason`。

**原因**：工业诊断需要“可停”的安全边界；没有证据时不能编造结论。固定阶段便于 UI 展示、
Eval 断言和故障定位，同时每个阶段内部仍按假设动态选择补查工具。

**影响**：Eval 同时统计可解完成率、必要转人工与不必要转人工；不能用“全部转人工”提高安全分。

## ADR-006 控制执行禁用，审批只确认建议意图

**选择**：`control_execution: 'disabled'` 是常量；诊断工具集合没有控制工具；高风险
（`control`/`control_intent`）建议不能由申请人自己审批；回执状态机
`submitted/acknowledged/failed/unknown` 只在隔离 fake actuator 中测试，未知回执永远不重提。

**原因**：本版本没有真实设备控制授权，也没有企业控制接口。审批必须能演示“人确认建议”，
但不能被误解为“系统已执行”。

**影响**：报告与 API 明确返回 `control_execution: disabled`；UI 显示“仅生成建议，不执行
真实控制”；审批通过不会改变设备状态。

## ADR-007 数据模式与适配器分层

**选择**：数据模式 `mock | replay | live`，模型模式 `fixture | live`。Mock/Replay 使用
本地 fixture store；Live 只使用配置固定的 REST base URL 与 endpoint 模板，或根云专有
adapter。未配置来源返回 `UNCONFIGURED`，不静默回退 Mock。根云 adapter 在没有接口文档、
签名规则和授权账号时不发请求。

**原因**：没有企业文档时猜测 endpoint/签名会产生错误集成；必须让“未配置”成为显式状态。

**影响**：`live` Run 在无已配置来源时返回 409；`INTEGRATION_STATUS.md` 逐来源标记状态。

## ADR-008 本地 FTS5 + 中文双字回退，不引入向量库

**选择**：知识检索使用 SQLite FTS5 trigram；中文无空格长词在 FTS/LIKE 召回不足时退化为
双字窗口；手册按机型/版本过滤，扫描 PDF 返回 `OCR_REQUIRED`，撤回文档不参与新检索但
历史报告引用保留。

**原因**：当前环境没有授权向量库/Embedding 服务；FTS 是可运行、可测试、可解释的本地方案。

**影响**：检索是词法的，不等同语义检索；报告与 UI 不宣称向量召回。

## ADR-009 50 例 Fixture Eval 是工程回归，不是模型精度声明

**选择**：50 例分为 FA/INS/MEC/MUL/SEN 五类，29 dev + 21 holdout；Fixture 模式跑完整
编排、工具、证据、报告校验和指标；Live Eval 在无授权 Provider 时标记 `NOT_RUN`。

**原因**：Fixture 规则能验证协议、边界、引用和回放，但不能证明真实模型准确率。两者必须
分开报告。

**影响**：CI 门禁只跑 Fixture Eval；发布报告不得把 50/50 写成真实模型精度。

## ADR-010 Web 工作台视觉与动效

**选择**：白色主背景、黑色文字、蓝色强调，Lucide 图标，无 Emoji；新元素有进入/过渡/退出，
按钮有轻反馈；列表/抽屉过渡一致；`prefers-reduced-motion` 下关闭动效。HashRouter 兼容
`/diagnosis` 静态入口。

**原因**：符合用户指定的视觉要求，并保证静态托管与深链接可用。

**影响**：新增页面必须复用 `diag-*` 样式与 `common.tsx` 组件；动效不能阻塞操作。

## ADR-011 WebSocket 事件先持久化后广播，支持 seq 补拉

**选择**：Run 事件写入 `diagnosis_events`，`seq` 在 Run 内单调递增；`/ws/diagnosis` 先订阅
再读 backlog，客户端断线后用 `after_seq` 补拉；事件类型覆盖创建、阶段、工具、证据、
假设、报告、复核、失败与取消。

**原因**：刷新/断线不能丢事件或乱序；UI 与 Eval 都需要可重放轨迹。

**影响**：WS 不是唯一真相源；所有状态可从数据库重建。

## ADR-012 保留 Miniclaw 入口与通用 Agent 兼容

**选择**：不修改 Miniclaw 原有 `/chat`、渠道、Agent Profile 等入口；诊断作为独立页面
`/diagnosis`。不恢复已废弃的通用 `runtime_policy.tools`。

**原因**：用户要求保留原产品可用性；诊断安全边界不能靠削弱通用 Agent 权限实现。

**影响**：两个入口共享用户/Workspace/数据库，但工具与策略隔离。

## ADR-013 E2E 使用系统 Chromium 覆盖，禁用视频

**选择**：`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向本机 Chromium 1248；
`web/playwright.diagnosis.config.ts` 不启用视频录制。

**原因**：Playwright 期望 revision 1234，本机安装 1248；ffmpeg 版本也不匹配。截图与 trace
足够验收，视频不是必需。

**影响**：CI 使用标准 Playwright 安装时无需覆盖；本地运行需设置该环境变量。

## ADR-014 演示账号不写入代码，空库沿用 Miniclaw 初始化

**选择**：`diagnosis:setup` 只写诊断领域数据与知识库，不创建用户、不设置默认密码。空库
打开 `/diagnosis` 走 Miniclaw 原有 setup 向导。本地验收使用的 `demo` 账号是本机演示数据，
不写入源码或文档模板。

**原因**：避免“通用默认密码”成为部署后门；测试账号只在隔离测试库/本地演示库创建。

**影响**：新环境首次使用需要管理员初始化；E2E 在隔离测试库创建临时管理员。
