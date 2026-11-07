# 基线记录（BASELINE）

记录时间：2026-11-07（Asia/Shanghai）
目标目录：`E:\工业诊断\industrial-diagnosis-agent`

## 1. 来源与许可证

| 项目 | 事实 |
| --- | --- |
| 源目录（只读） | 只读源快照（不记录本机绝对路径） |
| 源目录 Git | 无 `.git`，不能提供 commit；按文件哈希记录快照 |
| 产品/版本 | 基线工程 1.0.0 |
| 许可证 | MIT，`LICENSE` 保留在目标根目录 |
| 声明仓库 | `https://github.com/Akaliup/industrial-diagnosis-agent`（本次未验证上游可访问性，不据此声明上游状态） |
| 参考项目（只读） | Craft Agents 0.11.4（本地只读快照），Apache-2.0；仅参考界面交互，不迁移 Bun workspace/账号/会话服务 |

目标目录先建立本地 Git 基线，再开始实现：

```text
commit fec1d5af9459fd91f23e5ab8f0f5d41b91440754
baseline: import source snapshot
```

该提交的 `package.json`、`src/db.ts` 哈希与源目录逐字节一致，说明基线导入未夹带修改。
2026-11-07 创建公开仓库时清理了基线快照中的个人材料并重写历史，基线哈希由 `71a6ffb`
变为 `fec1d5a`；树内容除移除 `interview-prep/` 外一致，详见 §9。

## 2. 源快照关键哈希（SHA-256）

| 文件 | SHA-256 |
| --- | --- |
| `package.json` | `d1182e25ea86d3161a4a8ffed6443546b0703c97aa108fd8d3441fb981c46c8c` |
| `package-lock.json` | `31cb7d9c8683e77335ce12f7d71d87d2bb24ed7596f134267972f1c9eb5b61c5` |
| `src/db.ts` | `961b1eb108c7b5433f4c00fc68d2b2522823742399a26c913eb814230e755884` |
| `src/web.ts` | `7049af95711fe243369d25c21651f1a33b093ab7792347e72f90a07092b2213d` |
| `web/package.json` | `83a80cfc602d4f89f14a36b8dc3f8d4c6f3fb04c9cc3f2e8441311938fd80b3e` |
| `LICENSE` | `dfc65588cbc7c671c9db494c63d8889d419f7c0750a41a6329350bf43b4ed0f0` |

## 3. 环境

| 项 | 实测值 |
| --- | --- |
| OS | Windows 11 Home China 10.0.26200 |
| Node.js | v24.16.0 |
| npm | 11.13.0 |
| Git | 可用；本地基线提交 `fec1d5a`（历史重写后） |
| Python | 3.14（仅辅助脚本，不是运行时依赖） |
| 浏览器 | Playwright Chromium 1248；Playwright 期望 revision 1234，E2E 通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向已安装 Chromium |
| Docker | 未验证；本交付不依赖 Docker |
| 数据库 | better-sqlite3，SQLite 单文件 `data/db/messages.db` |
| 向量库/Embedding | 未使用；知识检索使用 SQLite FTS5 trigram + 词法召回 |

## 4. 依赖与锁文件

- 根目录、`web/`、`packages/industrial-diagnosis-mcp/` 分别使用 `npm ci` / 已提交 lockfile。
- `container/agent-runner/node_modules` 已存在，`self-test:agent-runner` 通过。
- 未执行全局 SDK 升级，未修改 npm 全局配置。
- 新增依赖仅为项目局部：`@hono/node-server`、`ws`（根已有）、MCP SDK（已有）、Zod（已有）。

## 5. 基线类型检查与构建

在基线 commit 的独立 worktree（`work/diagnosis/baseline-check`，通过 junction 复用 `node_modules`）实测：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | 通过 |
| `npm test -- --run` | 1 | 334 个测试文件，280 通过 / 54 失败；2744 个测试，2650 通过 / 71 失败 / 23 跳过 |

基线失败集中在 Windows 平台能力差异，而非业务断言：

- 符号链接创建/删除 `EPERM`（备份恢复、session 文件、host mount 等）；
- POSIX 路径与 `/usr/bin/node` 等 Linux 假设（node-resolver）；
- `tar` 命令与含冒号路径在 Windows 下失败（backup-restore）；
- 进程树终止、CardKit/streaming 环境缺失等宿主差异。

基线完整日志：`work/diagnosis/logs/baseline-tests.log`。

## 6. 本次实现后的对照

本次实现后的完整根测试结果见 `docs/diagnosis/ACCEPTANCE.md` 与
`work/diagnosis/logs/root-tests-final.log`。诊断专用测试全部通过；根测试的失败仍集中在上述
Windows 平台用例，未新增诊断相关失败。由于基线 worktree 与主工作区的依赖/数据目录不完全相同，
失败数量不能做严格一一对应，只用于确认失败类别与基线一致。

## 7. 未验证项

- Docker/Container 模式未运行；
- Electron 安装包未签名、未制作安装器；
- 企业实时来源、真实模型、根云接口均未配置，详见 `INTEGRATION_STATUS.md`。

## 8. 审计补修记录（2026-11-07）

补修基于同一基线 `fec1d5a` 与初次交付 `443136b`；R1–R6 补修本身未改写历史、
未重置用户数据，补修提交在交付后单独创建。
2026-11-07 创建公开仓库时发现基线快照包含与产品无关的个人 `interview-prep/` 材料，
已另行重写历史将其从所有提交移除并强制推送；本地工作副本仍保留，且被 `.gitignore`
忽略，不会再进入提交。重写后的关键提交：基线 `fec1d5a`、初次交付 `443136b`、
审计补修 `fd88584`、补修文档 `e89a11c`、忽略规则 `40c180e`；文件内容除移除该目录
和新增忽略规则外未变。

| 项 | 补修后事实 |
| --- | --- |
| 依赖 | 未新增根依赖；E2E 使用 `web/` 已安装的 Playwright 1.62.1 |
| 诊断 Schema | `DIAGNOSIS_SCHEMA_VERSION=2`，新增 `diagnosis_runs.lease_token` 迁移 |
| 数据隔离 | 单测使用 `mkdtemp` 临时库；诊断 E2E 使用 `work/diagnosis/e2e-data` + `INDUSTRIAL_DIAGNOSIS_DATA_DIR` + 端口 3199 |
| 本地假服务 | 诊断 E2E 在本机随机端口启动假 REST，不访问企业或外部网络 |
| 配置加载 | shell 环境变量 > `.env.diagnosis` > 代码默认值；无文件时静默使用默认值，非法值明确失败 |
| 诊断测试 | 19 文件 / 92 测试通过 |
| 诊断 E2E | 6/6 通过（隔离库） |
| 移动端 E2E | 9/9 通过（与诊断隔离） |
| 根测试 | 353 文件 / 2968 测试：321 文件通过、32 失败；2887 测试通过、58 失败、23 跳过；失败名称与初次交付完全一致，仍为 Windows 平台差异（见 `ACCEPTANCE.md` §5.1） |

本机 Playwright 1.62.1 期望 ffmpeg revision 1011，而已安装为 1013；移动端 E2E 运行时
把现有二进制复制到项目内 `work/diagnosis/pw-browsers/ffmpeg-1011`，未修改全局缓存。
该目录属于运行产物，不进入 Git；CI 使用标准 Playwright 安装时不需要。

## 9. 公开仓库历史清理（2026-11-07）

基线快照的 `interview-prep/` 目录包含与产品无关的个人面试准备材料。创建公开仓库后
发现该目录随基线提交进入历史，已使用 `git filter-branch` 从全部提交中移除，并强制
推送重写后的 `main` 与 `feat/industrial-diagnosis`。

- 移除范围：`interview-prep/` 14 个文件（232 KB），不涉及产品代码、测试、文档或数据。
- 本地保留：工作副本文件仍在项目目录中，仅从 Git 历史移除；`.gitignore` 新增
  `/interview-prep/`，防止再次提交。
- 重写影响：所有提交哈希变化，当前关键提交见 §8；旧哈希不再可达。
- 未修改：源目录、用户数据库、运行数据和其他产品文件。
