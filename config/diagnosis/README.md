# 诊断来源配置模板

本目录只放**模板**，不含真实地址、账号或密钥。

## 通用 REST

1. 在 `.env.diagnosis` 设置 `DIAGNOSIS_REST_BASE_URL` 与 `DIAGNOSIS_REST_TOKEN`。
2. 用 `DIAGNOSIS_REST_ENDPOINTS` 提供 endpoint 模板；默认值见
   `packages/industrial-diagnosis-mcp/src/adapters/index.ts`。
3. 用 `DIAGNOSIS_REST_MAPPING` 指向字段映射 JSON；格式参考
   `rest-mapping.example.json`。左侧为领域字段，右侧为远端响应点路径。
4. 先用只读测试账号验证状态、遥测、报警、MES、工单五类查询，再启用 `live` 数据模式。

## 根云

`rootcloud-mapping.example.json` 只是占位。缺少接口文档、签名规则、endpoint 和授权账号时，
`RootCloudAdapter` 必须返回 `UNCONFIGURED`，不得猜测签名或发送请求。

## 安全约束

- 模型不能传入 URL、SQL、文件路径或任意 header。
- 未配置来源返回 `UNCONFIGURED`；`live` 模式不会回退 Mock。
- 不要把真实密钥、Cookie、企业原始数据写入本目录或提交到 Git。
