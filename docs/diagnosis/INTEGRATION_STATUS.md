# 企业接入状态（INTEGRATION STATUS）

状态定义：

- `SCAFFOLD`：有接口/配置骨架，尚未用契约测试覆盖；
- `CONTRACT_TESTED`：协议、错误路径与适配器行为有自动化测试；
- `MOCK_TESTED`：用本地 Mock/Replay 数据跑通端到端；
- `LIVE_VERIFIED`：使用已授权企业环境与真实凭据验证；
- `UNCONFIGURED`：缺少企业文档、地址、账号或授权，未发送真实请求；
- `NOT_RUN`：需要真实模型/外部条件，本版本未执行。

## 1. 来源总表

| 来源 | 当前状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| 本地设备/时序/报警（fixture） | MOCK_TESTED | `npm run diagnosis:smoke`、50 例 Eval | 虚构设备与遥测，覆盖正常、漂移、磨损、多故障、来源超时 |
| SCADA / 实时库 | UNCONFIGURED | 通用 REST adapter + `tests/diagnosis/adapters.test.ts` | 无企业 base URL、认证方式、字段映射、资产映射 |
| MES 事件 | UNCONFIGURED | 同上；fixture 中有 MES 事件 | 无企业 MES 接口文档与测试账号 |
| 工单系统 | UNCONFIGURED | 同上；fixture 中有工单 | 无工单 API/字段样例/权限 |
| RootCloud 根云 | UNCONFIGURED | `RootCloudAdapter` 明确返回 `UNCONFIGURED`，`adapters.test.ts` 断言不发请求 | 无接口文档、签名规则、字段映射、授权账号 |
| 本地手册（PDF/Markdown） | MOCK_TESTED | `knowledge.test.ts`、文档预览 live 检查 | 文字层 PDF、页级定位、版本过滤、撤回；扫描件 `OCR_REQUIRED` |
| 历史案例 | MOCK_TESTED | `knowledge.test.ts`、50 例 Eval | 本地合成案例；无企业历史库 |
| 报警 Webhook | CONTRACT_TESTED + live 本地验证 | `webhook.test.ts`；本机签名/幂等/401/503 实测 | HMAC-SHA256，时间窗 5 分钟；生产需配置密钥 |
| 真实模型 Provider | NOT_RUN | `LiveRoleRunner` 实现 + 环境模板 | 未提供已授权 base URL/key/model；Live Eval 未运行 |
| Miniclaw 主服务/用户体系 | MOCK_TESTED | 登录、Workspace、诊断 SPA、E2E | 复用现有 Cookie 会话与 SQLite；未改主聊天路径 |

## 2. 通用 REST 适配器

已实现（`packages/industrial-diagnosis-mcp/src/adapters/rest.ts`）：

- 只接受服务端配置的 `DIAGNOSIS_REST_BASE_URL` 与 endpoint 模板；
- 模型不能提供 URL、SQL、文件路径；
- 支持 Bearer Token、超时、字段点路径映射；
- 错误映射为 `SOURCE_UNAVAILABLE`/`TIMEOUT`，不伪造成功；
- 适配器契约测试使用本地 HTTP 服务，验证鉴权头、路径参数、映射、503 与超时错误。

配置示例见 `.env.diagnosis.example` 与 `config/diagnosis/`。没有企业字段样例时不要填写猜测映射。

## 3. 每个来源仍缺少的条件

| 来源 | 缺少 |
| --- | --- |
| SCADA | base URL、认证方式、请求/响应样例、资产 ID 映射、时区、单位、限流、只读测试账号 |
| MES | base URL、事件字段、工单关联键、时间语义、分页、测试账号 |
| 工单 | API/只读账号、状态枚举、设备关联字段、附件策略 |
| RootCloud | 接口文档、签名/鉴权规则、endpoint、字段映射、租户与设备授权 |
| 手册 | 企业手册授权、版本策略、OCR 服务（如扫描件）、页级定位验收样本 |
| 历史案例 | 案例库导出/接口、脱敏规则、根因码映射 |
| 真实模型 | 已授权 Provider 的 base URL、API key、模型名、配额与数据合规确认 |

## 4. 状态边界

- `UNCONFIGURED` 不计入 `LIVE_VERIFIED`，也不计入工程版 PASS 的“企业接入”部分。
- Mock/Fixture 结果只证明协议与工程链路，不证明现场准确率。
- `live` 数据模式在无已配置来源时返回 409，不回退 Mock；这是有意设计。
- 控制执行在所有模式下均为 `disabled`；审批通过不会触发真实设备控制。
