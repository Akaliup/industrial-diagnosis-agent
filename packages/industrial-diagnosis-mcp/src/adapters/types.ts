import type {
  AlarmsData,
  CaseSearchData,
  CaseSearchInput,
  Coverage,
  DataMode,
  EquipmentQueryInput,
  EquipmentResolveData,
  EquipmentResolveInput,
  EquipmentStatusData,
  EvidenceDraft,
  EvidenceGetData,
  ManualSearchData,
  ManualSearchInput,
  ManualSectionData,
  ManualSectionInput,
  MesEventsData,
  TelemetryData,
  ToolError,
  ToolStatus,
  ToolWarning,
  WorkOrdersData,
} from '../contracts/domain.js';

export interface ToolResult<T> {
  status: ToolStatus;
  data: T | null;
  evidence: EvidenceDraft[];
  coverage: Coverage;
  warnings: ToolWarning[];
  error: ToolError | null;
  next_cursor: string | null;
}

export type EquipmentQueryData =
  | EquipmentStatusData
  | TelemetryData
  | AlarmsData
  | MesEventsData
  | WorkOrdersData;

export interface AdapterContext {
  workspaceId: string;
  runId: string;
  dataMode: DataMode;
  now: string;
  sourceAllowlist: string[] | null;
}

export interface DiagnosisAdapter {
  resolveEquipment(
    input: EquipmentResolveInput,
  ): Promise<ToolResult<EquipmentResolveData>>;
  query(input: EquipmentQueryInput): Promise<ToolResult<EquipmentQueryData>>;
  searchManual(input: ManualSearchInput): Promise<ToolResult<ManualSearchData>>;
  getManualSection(
    input: ManualSectionInput,
  ): Promise<ToolResult<ManualSectionData>>;
  searchCases(input: CaseSearchInput): Promise<ToolResult<CaseSearchData>>;
  getEvidence(ids: string[]): Promise<ToolResult<EvidenceGetData>>;
}
