# 设备智诊文档索引

本目录记录 Miniclaw 上新增的“设备智诊”工程版：报警 → 统一设备查询 → 状态确认 →
异常定位 → 假设生成 → 证据验证 → 引用报告 → 人工复核。

## 快速开始

```bash
npm run diagnosis:setup
npm run diagnosis:server
```

访问 `http://127.0.0.1:3100/diagnosis`。默认 `fixture` 模型 + `mock` 数据；空库首次打开
走 Miniclaw setup 向导。端口冲突时使用 `DIAGNOSIS_PORT`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 组件、五阶段、Tool Schema、数据模型、权限矩阵、事件协议、Web 页面 |
| [DEMO.md](DEMO.md) | 3–5 分钟演示步骤、截图、报告导出 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 实测命令、退出码、50 例指标、E2E、剩余条件 |
| [TASKS.md](TASKS.md) | M0–M8 任务与工程检查表 |
| [BASELINE.md](BASELINE.md) | 源快照、环境、哈希、基线测试失败 |
| [DECISIONS.md](DECISIONS.md) | ADR：运行时、工具边界、角色、证据、预算、审批、适配器、UI |
| [INTEGRATION_STATUS.md](INTEGRATION_STATUS.md) | 每个企业来源的 scaffold/contract/mock/live 状态 |
| [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) | Miniclaw/Craft 许可证与复用边界 |
| [PROJECT_STORY.md](PROJECT_STORY.md) | 本人新增工作、实测指标、难点与边界 |
| [../../config/diagnosis/README.md](../../config/diagnosis/README.md) | 通用 REST / 根云字段映射模板与接入说明 |

## 关键目录

```text
src/diagnosis/                        诊断服务、网关、编排、报告校验
packages/industrial-diagnosis-mcp/    只读 MCP 服务与 adapter
web/src/diagnosis/                    诊断 SPA
tests/diagnosis/                      55 个诊断测试
evals/diagnosis/                      50 例输入与 gold
fixtures/diagnosis/                   模拟设备/时序/报警/手册/案例
scripts/diagnosis/                    种子、demo、Eval、smoke
work/diagnosis/                       日志、Eval 产物、checkpoint（不提交运行数据）
docs/diagnosis/                       本目录
```

## 安全边界（摘要）

- 诊断工具固定六个只读工具；未知工具、控制工具、越界设备、额外参数被网关拒绝。
- 证据 ID 入库重算；报告引用逐条校验设备、时间、机型、手册版本与 payload hash。
- `control_execution: disabled`；高风险建议不能自审批；审批不触发设备控制。
- 未配置企业来源返回 `UNCONFIGURED`，`live` 模式不回退 Mock。
- 未配置真实模型时 Live Eval 为 `NOT_RUN`，不声明真实模型精度。
