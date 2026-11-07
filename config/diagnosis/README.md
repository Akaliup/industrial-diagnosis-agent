# 诊断来源配置模板

本目录只放**模板**，不含真实地址、账号或密钥。

## 通用 REST

1. 在 `.env.diagnosis` 设置 `DIAGNOSIS_REST_BASE_URL` 与 `DIAGNOSIS_REST_TOKEN`。
2. 用 `DIAGNOSIS_REST_ENDPOINTS` 提供 endpoint 模板；默认值见
   `packages/industrial-diagnosis-mcp/src/adapters/index.ts`。
3. 用 `DIAGNOSIS_REST_MAPPING` 提供字段映射：可写内联 JSON（以 `{` 开头），也可写文件
   路径；格式参考 `rest-mapping.example.json`。左侧为领域字段，右侧为远端响应点路径。
4. 先用只读测试账号验证状态、遥测、报警、MES、工单五类查询，再启用 `live` 数据模式。

## 根云

`rootcloud-mapping.example.json` 只是占位。缺少接口文档、签名规则、endpoint 和授权账号时，
`RootCloudAdapter` 必须返回 `UNCONFIGURED`，不得猜测签名或发送请求。

## 配置加载与验证

- 服务、setup、Eval、smoke 统一先加载 `src/diagnosis/load-env.ts`。
- 优先级：shell 环境变量 > `.env.diagnosis` > 代码默认值；可用 `DIAGNOSIS_ENV_FILE`
  指向其他文件。
- 端口、租约、超时、数据/模型模式、JSON 端点、Webhook 密钥、映射文件路径都会校验；
  非法值直接失败，不静默回退。
- `DIAGNOSIS_MODEL_MODE=live` 必须同时提供 base URL、API key、模型名，否则启动失败。

## 配置后的链路

1. 在“数据与知识”页创建 `live` 来源，或调用 `POST /api/diagnosis/sources`。
2. 调用 `POST /api/diagnosis/sources/:id/test`；只有只读探测成功才变为 `configured`。
3. 创建 `data_mode=live` 的 Run；没有 `configured` 来源时返回 409，不回退 Mock。
4. 通用 REST 适配器当前只证明连接与设备解析；没有证据时报告明确转人工，不伪造数据。

## 安全约束

- 模型不能传入 URL、SQL、文件路径或任意 header。
- 未配置来源返回 `UNCONFIGURED`；`live` 模式不会回退 Mock。
- 不要把真实密钥、Cookie、企业原始数据写入本目录或提交到 Git。
