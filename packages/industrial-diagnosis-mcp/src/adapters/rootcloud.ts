import type {
  AlarmsData,
  CaseSearchData,
  EquipmentQueryInput,
  EquipmentResolveData,
  EquipmentStatusData,
  EvidenceGetData,
  ManualSearchData,
  ManualSectionData,
  MesEventsData,
  TelemetryData,
  WorkOrdersData,
} from '../contracts/domain.js';
import type { AdapterContext, DiagnosisAdapter, ToolResult } from './types.js';

/**
 * 根云专有适配器占位。
 *
 * 没有企业接口文档、签名规则、字段映射和授权账号时，必须明确返回
 * UNCONFIGURED，不得猜 endpoint 或伪造签名。字段映射模板见
 * config/diagnosis/rootcloud-mapping.example.json。
 */
export class RootCloudAdapter implements DiagnosisAdapter {
  constructor(private readonly ctx: AdapterContext) {}

  private unconfigured<T>(): Promise<ToolResult<T>> {
    return Promise.resolve({
      status: 'error',
      data: null,
      evidence: [],
      coverage: {
        from: this.ctx.now,
        to: this.ctx.now,
        complete: false,
        missing: ['UNCONFIGURED'],
      },
      warnings: [
        {
          code: 'ROOTCLOUD_UNCONFIGURED',
          message:
            '根云接口文档、签名规则和授权账号未提供；本适配器不发送任何请求',
        },
      ],
      error: {
        code: 'UNCONFIGURED',
        retryable: false,
        safe_message: '根云来源未配置（缺少接口文档/签名/账号）',
      },
      next_cursor: null,
    });
  }

  resolveEquipment(
    _input: Parameters<DiagnosisAdapter['resolveEquipment']>[0],
  ): Promise<ToolResult<EquipmentResolveData>> {
    return this.unconfigured();
  }
  query(
    _input: EquipmentQueryInput,
  ): Promise<
    ToolResult<
      | EquipmentStatusData
      | TelemetryData
      | AlarmsData
      | MesEventsData
      | WorkOrdersData
    >
  > {
    return this.unconfigured();
  }
  searchManual(
    _input: Parameters<DiagnosisAdapter['searchManual']>[0],
  ): Promise<ToolResult<ManualSearchData>> {
    return this.unconfigured();
  }
  getManualSection(
    _input: Parameters<DiagnosisAdapter['getManualSection']>[0],
  ): Promise<ToolResult<ManualSectionData>> {
    return this.unconfigured();
  }
  searchCases(
    _input: Parameters<DiagnosisAdapter['searchCases']>[0],
  ): Promise<ToolResult<CaseSearchData>> {
    return this.unconfigured();
  }
  getEvidence(_ids: string[]): Promise<ToolResult<EvidenceGetData>> {
    return this.unconfigured();
  }
}
