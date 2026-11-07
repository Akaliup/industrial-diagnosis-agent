# 来源与复用边界（SOURCE PROVENANCE）

## 1. 直接来源

| 项目 | 版本 | 许可证 | 使用方式 |
| --- | --- | --- | --- |
| 基线工程（上游快照） | 1.0.0 | MIT | 目标项目基线；保留其 Node/TypeScript、Hono、React、SQLite、鉴权、Web 构建、测试与 CI 结构 |
| Craft Agents（本地快照） | 0.11.4 | Apache-2.0 | 只参考工作台的信息层级、状态步骤条、证据抽屉、复核队列等交互模式；未复制其 Bun workspace、账号体系、Electron IPC、会话服务或后台任务实现 |

基线工程的 `LICENSE`、`README.md`、`SECURITY.md` 与原有依赖锁文件均保留。
Craft 的源码没有进入目标目录，因此没有分发其代码；本文记录参考关系，便于后续审计。

## 2. 本次新增代码

以下目录为本任务新增，未从第三方整体复制：

```text
src/diagnosis/                        诊断运行时、MCP 网关、五阶段编排、报告校验
packages/industrial-diagnosis-mcp/    只读 MCP 服务与 mock/replay/live adapter
shared/diagnosis/                     共享协议生成物
web/src/diagnosis/                    设备智诊 Web 工作台
web/diagnosis.html                    独立 SPA 入口
tests/diagnosis/                      诊断契约、策略、检索、编排、审批、Webhook、Eval 测试
scripts/diagnosis/                    种子、演示、Eval、MCP/pipeline smoke
fixtures/diagnosis/                   虚构设备、时序、报警、MES、工单、手册
evals/diagnosis/                      50 例输入与 gold
```

新增代码的许可证跟随目标项目 MIT。生成物（`contracts.generated.ts`、MCP 子包
`contracts/generated`）由 `scripts/diagnosis/sync-contracts.ts` 从单一源
`src/diagnosis/contracts/domain.ts` 生成，不应手工修改。

## 3. 第三方依赖

沿用基线工程已锁定的依赖，没有新增需要改变许可证边界的运行时：

| 依赖 | 用途 | 许可证（上游声明） |
| --- | --- | --- |
| Hono / `@hono/node-server` | 诊断 HTTP 服务与静态资源 | MIT |
| React / React Router / Radix UI / Lucide / Recharts | 工作台 UI | MIT / Apache-2.0（Radix 为 MIT） |
| Zod | 输入/输出契约 | MIT |
| better-sqlite3 | 本地持久化与 FTS5 | MIT |
| `@modelcontextprotocol/sdk` | MCP stdio JSON-RPC | MIT |
| `ws` | 诊断事件 WebSocket | MIT |
| Vitest / Playwright | 测试 | MIT / Apache-2.0 |
| pdfjs-dist | 手册 PDF 文本层解析 | Apache-2.0 |

许可证以各依赖包内 `LICENSE` 为准；本表不替代依赖清单。

## 4. 明确未复用/未声明的内容

- 没有把 Craft 的 Bun 工作区、账户、登录态、Electron IPC 或任何真实用户数据搬入目标目录。
- 没有使用真实企业设备数据、真实工单、真实手册或真实 RootCloud 接口。
- `fixtures/diagnosis/` 与 `evals/diagnosis/` 中的设备、报警、手册、案例均为虚构或合成数据，并在 UI/报告中标注“模拟数据 / Fixture 预录推理”。
- 没有复制上游仓库的 Git 历史；目标仓库的基线提交是本任务建立的本地快照。
- 没有把任何个人密钥、Cookie、企业账号写入源码、fixture、文档或提交。

## 5. 参考的交互模式

| 交互 | 参考点 | 本次实现 |
| --- | --- | --- |
| 五阶段状态条 | Craft 任务步骤/状态展示 | `web/src/diagnosis/components/StageTimeline.tsx`，使用本项目 Run 事件驱动 |
| 证据抽屉 | Craft 右侧详情抽屉 | `EvidenceDrawer.tsx`，数据来自诊断 Evidence API |
| 复核队列 | Craft 待处理列表 | `ReviewsPage.tsx`，数据来自 `diagnosis_runs` / `diagnosis_reviews` |
| 工具调用轨迹 | Agent 运行轨迹展示 | `ToolTrace.tsx`，展示 PolicyGateway 记录的逻辑调用与尝试 |

这些组件按基线工程的 React 19、Tailwind 4、Radix 组件体系重写，没有引入 Craft 的运行时依赖。
