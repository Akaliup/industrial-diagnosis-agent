# 任务清单（TASKS）

状态标记：`PASS` 已完成并验证；`PARTIAL` 已完成但存在明确限制；`BLOCKED_EXTERNAL` 缺外部条件；
`NOT_RUN` 未执行；`FAIL` 失败。

## M0 源码、环境与基线 — PASS

- [x] 只读源目录检查，目标目录安全复制，排除 `.git`、`node_modules`、运行数据与日志
- [x] 保留 `LICENSE`、lockfile、`.env.example`、原文档
- [x] 本地 Git 基线提交 `71a6ffb`，关键文件 SHA-256 记录在 `BASELINE.md`
- [x] 记录 Node/npm/OS/浏览器环境与基线测试失败原貌
- [x] 三个 Node 项目依赖安装与锁文件保留

## M1 协议与真实运行链路 — PASS

- [x] 单一领域协议 `src/diagnosis/contracts/domain.ts` 与生成副本 hash 校验
- [x] 独立 MCP stdio 服务，六个只读工具
- [x] 主服务 MCP Client、PolicyGateway、RoleRunner、Run 事件
- [x] 真实 MCP transport smoke：注册/发现/执行/响应/证据/事件
- [x] 恶意角色输出、未知工具、额外参数、设备越界、控制风险注入均被拒绝
- [x] 取消传播与子进程清理测试

## M2 单场景垂直闭环 — PASS

- [x] 诊断表迁移、种子数据、报警入库、新建 Run
- [x] 五阶段持久化与事件序列
- [x] 机械异常场景（传感器漂移/轴承磨损）与来源失败转人工场景
- [x] 工作台：触发、阶段进度、报告、引用抽屉、取消、刷新恢复
- [x] 后台重启/过期租约接管测试（`worker.test.ts`）

## M3 数据质量与知识检索 — PASS

- [x] 五类统一查询：status/telemetry/alarms/mes_events/work_orders
- [x] 分页、单位、时间窗、缺失/乱序/时钟偏移/低质量标记
- [x] PDF/Markdown 手册导入、中文 FTS、型号/版本过滤、页级定位
- [x] 历史 Case 检索、ContextManifest、撤回文档
- [x] 错误型号、旧版、扫描件 `OCR_REQUIRED`、空检索、冲突证据测试
- [x] 引用抽屉定位真实页/记录；删除/撤回索引不破坏旧报告引用

## M4 动态验证与权限恢复 — PASS

- [x] 四个逻辑角色与按假设动态补查
- [x] 反证保留、预算、重复调用守卫、熔断、有限重试
- [x] 跨用户/Workspace ACL、审批意图、未知回执模拟
- [x] 取消、租约、断点恢复
- [x] 审计 Trace 与脱敏字段

## M5 产品工作台与本地交付 — PASS

- [x] 报警收件箱、发起诊断、工作台、设备台账、数据与知识、复核与审批、评测与回放
- [x] 三种尺寸、键盘/触屏、进入/过渡/退出、reduced-motion
- [x] 报告 JSON/Markdown/HTML 导出；HTML 可浏览器打印
- [x] 幂等 `diagnosis:setup`，空库沿用 Miniclaw 初始化
- [x] 真实运行截图（`docs/diagnosis/screenshots/`）
- [x] Electron typecheck/build 通过；未制作签名安装包

## M6 适配层与可用真实来源 — PARTIAL（工程完成，企业条件缺失）

- [x] SCADA/MES/工单通用 REST adapter、配置 schema、Mock fixtures
- [x] RootCloud adapter 明确 `UNCONFIGURED`，字段映射模板
- [x] REST adapter 契约测试（鉴权、路径、映射、503/超时）
- [x] live 缺配返回 409，不静默回退 Mock
- [ ] 企业真实来源 live 验证 — `BLOCKED_EXTERNAL`（无地址/账号/文档/授权）

## M7 Eval、回归与真实模型验证 — PARTIAL

- [x] 50 例、29 dev / 21 holdout、Trace replay、指标与 CI 门禁
- [x] Fixture Eval 50/50，指标全 1.0，门禁通过
- [x] `LiveRoleRunner` 真实调用路径、配置模板、错误处理
- [ ] Live Eval — `NOT_RUN`（无已授权模型 Provider）
- [ ] 真实模型准确率 — 不作声明

## M8 总体验收与交接 — PARTIAL（外部条件待补）

- [x] 全量诊断测试、类型检查、构建、smoke、E2E、fresh data 演示
- [x] 本地 Git 提交准备与差异检查
- [x] 验收报告、启动说明、架构、演示步骤、来源记录
- [x] 停止自建测试服务；保留用户原有进程
- [ ] 企业现场验收 / 真实模型质量验收 — `BLOCKED_EXTERNAL` / `NOT_RUN`

## 工程检查表（对应方案 12.3）

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| 来源快照、基线、许可证、移植记录 | PASS | `BASELINE.md`、`SOURCE_PROVENANCE.md`、commit `71a6ffb` |
| 新旧数据库安装/迁移/备份恢复 | PARTIAL | 诊断迁移与临时库测试通过；Miniclaw 备份恢复用例在 Windows 因 symlink `EPERM` 失败，属基线平台问题 |
| 统一 Tool 输入/输出/MCP/错误协议 | PASS | `contracts.test.ts`、`mcp-smoke.ts`、`diagnosis:smoke` |
| 五阶段真实持久化、按假设补查 | PASS | `orchestrator.test.ts`、`diagnosis:demo`、Eval traces |
| 引用可打开、错误版本/设备/作用域拒绝 | PASS | `report-validator.test.ts`、E2E 证据抽屉、`knowledge.test.ts` |
| 单来源宕机/缺失/陈旧/单位/时间错位 | PASS | INS 10 例、`knowledge.test.ts`、来源超时 demo |
| 重试/重复检测/预算 | PASS | `repeat-guard.test.ts`、`policy.test.ts`、`tool-gateway.test.ts` |
| 取消/刷新/WS 重连/重启/重复 webhook | PASS | `worker.test.ts`、WS 本机回放、`webhook.test.ts`、live webhook 实测 |
| 工具集合与 ACL 不可绕过；控制执行零次 | PASS | `policy.test.ts`、`approval-policy.ts`、E2E 安全提示 |
| 人工复核与建议审批可用；审批不启用控制 | PASS | E2E 复核、`approvals.test.ts`、live 自审批 403 |
| 手册导入/中文检索/页码/版本/Case | PASS | `knowledge.test.ts`、文档预览 live 检查 |
| 50 例回放、gold 不进 Agent context | PASS | `eval-replay.test.ts`、`eval-gate` 50/50 |
| 核心 E2E：成功/缺证据/重复/取消/跨工作区/错误版本 | PASS | Playwright 2 项 + 单元测试；跨工作区由 ACL/workspace resolve 测试覆盖 |
| 三尺寸/键盘触屏/动效/reduced-motion | PASS | E2E 截图 1440/1024/390，`styles.css` |
| Web 构建与 smoke；Electron 状态 | PASS | 构建 exit 0；Electron typecheck/build exit 0；无签名安装包 |
| fresh data 演示可复现、报告导出可打开 | PASS | `work/diagnosis/logs/fresh-*.log`、`docs/diagnosis/artifacts/` |
| 验收报告分工程/真实模型/企业接入 | PASS | `ACCEPTANCE.md` |

## 已知限制

1. 根测试在 Windows 有 58 项失败，基线同类失败 71 项；均为符号链接、POSIX 路径、tar、进程树等平台差异，诊断套件 55/55 通过。
2. Live Eval、真实模型质量、企业来源 live 验证未执行。
3. Docker/Container 模式未验证；Electron 仅 build/typecheck，未签名打包。
4. 知识检索是 FTS5 词法检索，不是向量语义检索。
5. 报告中的控制建议不会执行；审批只记录建议意图。
