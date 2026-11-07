# 基线记录（BASELINE）

记录时间：2026-11-07（Asia/Shanghai）
目标目录：`E:\工业诊断\industrial-diagnosis-agent`

## 1. 来源与许可证

| 项目 | 事实 |
| --- | --- |
| 源目录（只读） | `C:\Users\lz\Downloads\项目源码+简历生成skill\工业诊断\miniclaw-main` |
| 源目录 Git | 无 `.git`，不能提供 commit；按文件哈希记录快照 |
| 产品/版本 | Miniclaw 1.0.0 |
| 许可证 | MIT，`LICENSE` 保留在目标根目录 |
| 声明仓库 | `https://github.com/helsome/miniclaw`（本次未验证上游可访问性，不据此声明上游状态） |
| 参考项目（只读） | `C:\Users\lz\Downloads\项目源码+简历生成skill\工业诊断\craft-agents-oss-main`，Craft Agents 0.11.4，Apache-2.0；仅参考界面交互，不迁移 Bun workspace/账号/会话服务 |

目标目录先建立本地 Git 基线，再开始实现：

```text
commit 71a6ffb9df16761aa6d5752cfc0baaef1498769f
baseline: import Miniclaw 1.0.0 source snapshot
```

该提交的 `package.json`、`src/db.ts` 哈希与源目录逐字节一致，说明基线导入未夹带修改。

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
| Git | 可用；本地基线提交 `71a6ffb` |
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
