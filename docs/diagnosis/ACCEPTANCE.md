# 验收报告（ACCEPTANCE）

验收日期：2026-11-07
项目位置：`E:\工业诊断\industrial-diagnosis-agent`
基线提交：`71a6ffb9df16761aa6d5752cfc0baaef1498769f`

## 1. 状态结论

| 维度 | 状态 | 说明 |
| --- | --- | --- |
| 工程版 | **PASS（附平台限制）** | 诊断协议、工具网关、五阶段编排、报告校验、知识检索、审批边界、UI、Eval、E2E、构建均通过；根测试在 Windows 有基线平台失败，诊断套件全通过 |
| 真实模型 | **NOT_VERIFIED / NOT_RUN** | 未提供已授权模型 Provider；`LiveRoleRunner` 已实现，Live Eval 未运行；不声明模型准确率 |
| 企业接入 | **UNCONFIGURED** | SCADA/MES/工单/RootCloud 均无企业文档、地址、账号或授权；Mock/REST 契约已测试 |
| 控制执行 | **DISABLED** | 所有模式 `control_execution: disabled`；审批只确认建议意图，不执行设备控制 |

## 2. 启动与访问

```bash
npm run diagnosis:setup
npm run diagnosis:server
```

- 访问：`http://127.0.0.1:3100/diagnosis`
- 模式：`fixture` 模型 + `mock` 数据
- 空库：打开页面走 Miniclaw 原有 setup 向导创建管理员
- 本机演示库已有 `demo` 管理员；密码仅用于本机演示，不写入源码/部署模板
- 端口冲突：设置 `DIAGNOSIS_PORT`，不要终止占用进程

## 3. 实测命令与结果

| 命令 | 时间 | 退出码 | 结果 / 产物 |
| --- | --- | --- | --- |
| `npm run diagnosis:sync-check` | 17:12 | 0 | 契约一致 |
| `npm run diagnosis:check` | 17:02 | 0 | 12 文件 / 55 测试通过（`check-final3.log`） |
| `npx vitest run tests/diagnosis` | 17:12 | 0 | 12 文件 / 55 测试通过（`check-final4.log`） |
| `npm run diagnosis:eval:gate` | 17:04 | 0 | 50/50，指标见下（`eval-gate-final2.log`） |
| `npm run diagnosis:smoke` | 17:04 | 0 | 六工具 MCP + pipeline 通过（`smoke-final2.log`） |
| `npm run diagnosis:demo` | 17:04 | 0 | 5 场景 failures=0（`demo-final2.log`） |
| `npm run build` | 17:08 | 0 | 根 TypeScript 构建 |
| `npm run build:web` | 17:08 | 0 | `web/dist`（含 `diagnosis.html`） |
| `npm run diagnosis:build:mcp` | 17:12 | 0 | MCP `dist/server.js` |
| Web `npx tsc --noEmit` | 17:08 | 0 | Web 类型检查 |
| MCP `npm run typecheck` | 17:12 | 0 | MCP 类型检查 |
| `npm run desktop:typecheck` | 17:08 | 0 | Electron 类型检查 |
| `npm run desktop:build` | 17:08 | 0 | Electron main/preload |
| `npm run self-test:agent-runner` | 17:08 | 0 | Runner self-test 通过 |
| `npm run docs:check` | 17:09 | 0 | 69 个 Markdown 文件一致 |
| `git diff --check` | 17:09 | 0 | 无空白错误 |
| `npm test -- --run` | 17:07 | 1 | 346 文件：314 通过 / 32 失败；2931 测试：2850 通过 / 58 失败 / 23 跳过 |
| Playwright 诊断 E2E | 17:06 | 0 | 2/2 通过，10.8s（`web/tests/e2e/diagnosis`） |
| `npm run format:check` | 17:09 | 1 | 脚本在 Windows 调用 `node_modules/.bin/prettier` 无扩展名，`spawnSync ENOENT`；改用 `npx prettier --check` 通过 |

### 3.1 根测试失败说明

- 基线 worktree 实测：54 个文件 / 71 个测试失败；本次：32 个文件 / 58 个测试失败。
- 失败类别：Windows 符号链接 `EPERM`、POSIX 路径假设、`tar`/含冒号路径、进程树终止、
  CardKit/streaming 环境缺失。
- 诊断测试 55/55 通过；没有新增诊断相关失败。
- 基线日志：`work/diagnosis/logs/baseline-tests.log`；本次日志：
  `work/diagnosis/logs/root-tests-final2.log`。

## 4. 50 例 Fixture Eval

产物：`work/diagnosis/eval/eval_mw66fb77_all/report.md` 与 `summary.json`。

| 指标 | 值 |
| --- | --- |
| total / passed | 50 / 50 |
| citation_integrity | 1.0 |
| unauthorized_calls | 0 |
| missed_handoff | 0 |
| counter_evidence_retained | 1.0 |
| evidence_coverage | 1.0 |
| required_tool_recall | 1.0 |
| solvable_completion | 1.0 |
| unnecessary_handoff | 0 |
| top3_hit | 1.0 |
| multi_fault_coverage | 1.0 |
| threshold_check | ok，failures=[] |
| live_eval | `NOT_RUN (未配置真实模型)` |

分类：FA 10、INS 10、MEC 10、MUL 10、SEN 10；dev 29、holdout 21。

## 5. E2E 与截图

命令：

```bash
cd web
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="C:/Users/lz/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe" \
  npx playwright test --config playwright.diagnosis.config.ts
```

结果：2 passed（主链路 + 人工复核锁定）。

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

## 6. Fresh data 演示

在独立项目副本（`work/diagnosis/fresh-demo`，已清理）中从空数据目录执行：

1. `npx tsx scripts/diagnosis/setup.ts` → exit 0，5 条模拟报警；
2. `DIAGNOSIS_PORT=3200 npx tsx src/diagnosis/server.ts` → health 200；
3. `POST /api/auth/setup` 创建管理员 → 201；
4. 从 `demo-sensor-drift` 报警创建 Run → `awaiting_human`；
5. 报告结论 `sensor_drift: supported`、`bearing_wear: contradicted`，校验 `valid=true`；
6. Markdown 导出 4043 bytes。

产物：`docs/diagnosis/artifacts/fresh-demo-report.md`；日志：
`work/diagnosis/logs/fresh-setup.log`、`fresh-server.log`。

## 7. 本机 live 检查

| 检查 | 结果 |
| --- | --- |
| 登录 / 会话 Cookie | demo 用户登录成功 |
| 取消 Run | `202 cancelled=true`，事件 `run.created,tool.started,run.cancelled` |
| 续诊 | 从拒绝复核的 Run 创建新 Run，进入 `awaiting_human` |
| WebSocket | 52 个事件 seq 单调；`after_seq` 补拉无缺口 |
| Webhook | 合法签名 201、重复 200 同 ID、错误签名 401、未配置来源 503 |
| 自审批 | 高风险控制建议申请人自批 → 403 `SELF_APPROVAL_FORBIDDEN` |
| 文档预览 | Markdown `text/markdown` 200；PDF `application/pdf` 200 |
| 报告导出 | Markdown/HTML 可打开；复核后显示 `accepted` / `engineer_confirmed` |

## 8. 报告与产物

```text
docs/diagnosis/artifacts/demo-report-reviewed.md
docs/diagnosis/artifacts/demo-report-reviewed.html
docs/diagnosis/artifacts/fresh-demo-report.md
docs/diagnosis/screenshots/
work/diagnosis/eval/eval_mw66fb77_all/
work/diagnosis/logs/
```

## 9. 未完成 / 外部条件

1. **真实模型**：无已授权 Provider（base URL / key / model / 配额）；Live Eval 未运行，
   不声明准确率。
2. **企业来源**：SCADA、MES、工单、RootCloud 均缺接口文档、地址、认证、字段样例、
   资产映射、时区/单位/限流说明和只读测试账号；状态 `UNCONFIGURED`。
3. **Docker/Container**：未验证容器隔离与容器内 Runner；本版使用 Host 本地运行。
4. **Electron 安装包**：typecheck/build 通过，但无签名证书，未制作安装器。
5. **Windows 根测试**：58 项平台相关失败；未修改基线断言或放宽阈值。
6. **format:check 脚本**：Windows `.bin` shim 兼容问题；已用 `npx prettier --check` 验证
   本次代码格式。

## 10. 结论

工程版可以本地启动、从报警跑到带引用报告、复核、审批、Eval 与导出；所有诊断核心检查通过。
真实模型质量、企业实时接入、容器隔离和签名安装包仍需外部条件，未计入工程版 PASS。
