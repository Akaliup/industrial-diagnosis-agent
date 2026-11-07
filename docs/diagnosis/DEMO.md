# 3–5 分钟演示步骤

## 1. 启动

在目标根目录：

```bash
npm run diagnosis:setup
npm run diagnosis:server
```

打开 `http://127.0.0.1:3100/diagnosis`。

- 空库首次打开：按页面提示创建管理员（工业诊断 Agent 原 setup 流程）。
- 本机演示库已有 `demo` 管理员；密码只在本机演示环境使用，不写入源码或部署模板。
- 端口占用时设置 `DIAGNOSIS_PORT=3101`（或其它空闲端口），不要终止占用进程。
- 默认模式：`fixture` 模型 + `mock` 数据；右上角显示“模拟数据 / 预录演示推理 / 控制执行禁用”。

## 2. 演示路径

### 2.1 报警收件箱（约 30 秒）

1. 进入“报警收件箱”。
2. 展示 5 条模拟报警：传感器漂移、轴承磨损、通讯误报、多故障、来源超时。
3. 指出“载入演示数据”是幂等种子；空库可一键补齐。

### 2.2 1 号循环泵：传感器漂移（约 90 秒）

1. 在 `1号循环泵 / DEMO-BRG-01` 行点击“开始诊断”（已有任务则“查看诊断”）。
2. 工作台展示五阶段：确认状态 → 定位异常 → 生成假设 → 验证证据 → 生成报告。
3. 观察右侧预算：轮次、工具调用、模型调用均在限制内。
4. 报告结论：`传感器漂移 sensor_drift`，状态“已支持”，置信度 high；
   反证：`轴承磨损 bearing_wear` 被反驳。
5. 点击任意 `ev_...` 证据 chip，打开证据抽屉：来源、时间、payload hash、手册页码/原文。
6. 指出报告限制：Mock 数据、Fixture 预录推理，不作为现场维修依据。

### 2.3 人工复核（约 45 秒）

1. 滚动到“人工复核”。
2. 选择“接受结论”，填写意见，提交。
3. 复核后表单锁定，显示“复核已完成”；报告结论状态变为“工程师已确认”。
4. 如需调整：点击“补充信息后继续诊断”，生成新的续诊 Run，历史结论保留。

### 2.4 建议审批与安全边界（约 30 秒）

1. 在建议卡片点击“登记审批建议”。
2. 说明：审批只确认建议意图，`control_execution: disabled`，不会执行真实设备控制。
3. 高风险建议不能由申请人自己批准；换第二个有 Workspace 权限的账号才能批准。

### 2.5 来源失败转人工（约 30 秒）

1. 返回收件箱，打开 `2号循环泵` 的来源超时场景。
2. 报告结论为 `insufficient_evidence`，明确“存在未解决的关键证据缺口”，不编造数值。
3. 指出这是有意设计：来源超时/缺失时转人工，而不是回退 Mock。
4. 在“数据与知识”页展示来源状态与“测试连接”：`live` 来源只有探测成功才会变成
   `configured`；本机演示连接的是本地假 REST，不是企业系统。

### 2.6 评测与回放（约 45 秒）

1. 进入“评测与回放”。
2. 展示 50 例、通过 50、引用完整性 1.0、未授权调用 0、Top-1 1.0、反证适用 23 例且保留
   1.0、工具选择准确率 1.0、转人工准确率 1.0。
3. 打开任一用例的 Trace：五阶段、工具调用、逐次模型调用（模型、token、延迟、工具请求）、
   证据、报告校验。
4. 指出工具轨迹会显示 `inflight`、`unknown`、`cancelled` 等状态；`unknown` 表示进程在
   请求与回执之间崩溃，恢复时不会把它当成成功。
5. 运行 `npm run diagnosis:replay`，展示 `inference_calls=0 tool_calls=0`：
   这是只读 Trace 重放，不是重新调用模型。
6. 强调：Fixture Eval 是工程回归，不是真实模型精度。真实模型使用已授权 DeepSeek 兼容
   端点：10 例 dev 试点全部通过，全量 50 例通过 23（dev 14/29、holdout 9/21），指标与
   失败分析见 `ACCEPTANCE.md` §6.1；这不代表企业现场精度。未配置真实模型时 Live Eval
   显示 `NOT_RUN`，不展示任何伪造的准确率。
7. Phase 3 开发集 10 例：展示 `docs/diagnosis/artifacts/phase3-live/` 的 Trace 目录。
   说明 Fixture 10/10 只是回归；真实模型完整尝试 6/10（最终修复前），修复后的机械 2/2、
   `mul-align-lube`、`mul-bearing-drift` 定向通过；最终 10 例复验因 HTTP 402 为
   `NOT_RUN`。打开 `full-2/phase3-mul-bearing-drift.json` 展示预算耗尽误转人工的失败，
   再打开 `targeted/phase3-mul-bearing-drift.json` 展示修复后两个独立根因与报告限制说明。
   不要把这组定向结果说成 10/10 或企业现场精度。

## 3. 报告导出

工作台右上角：

- “Markdown”：下载 `.md`；
- “报告页”：浏览器打开 HTML，可直接打印为 PDF。

已生成的示例：

```text
docs/diagnosis/artifacts/demo-report-reviewed.md
docs/diagnosis/artifacts/demo-report-reviewed.html
docs/diagnosis/artifacts/fresh-demo-report.md
```

## 4. 演示截图

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

## 5. 演示时不要做的事

- 不要声称已接入真实企业设备、真实模型或真实控制。
- 不要把 Mock/Fixture 指标说成现场准确率。
- 不要执行真实设备控制；本版没有控制工具。
- 不要把本机演示账号密码复制到生产环境或文档模板。
