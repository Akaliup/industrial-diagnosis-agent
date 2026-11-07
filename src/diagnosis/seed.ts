import fs from 'node:fs';
import path from 'node:path';
import type { DataMode, DiagnosisSource } from './contracts/domain.js';
import type { KnowledgeService } from './knowledge.js';
import type { DiagnosisRepository } from './repository.js';
import { stableScopedId } from './util.js';

interface EquipmentFixture {
  equipment_id: string;
  name: string;
  vendor: string;
  model: string;
  serial: string;
  asset_category: string;
  manual_document_id?: string;
  manual_version?: string;
  source_ids: Record<string, string>;
  metrics: Record<
    string,
    { unit: string; normalized_unit?: string; normal_range?: [number, number] }
  >;
}

interface AlarmFixture {
  source_id: string;
  source_alarm_id: string;
  equipment_id: string;
  code: string;
  severity: string;
  state: string;
  raised_at: string;
  cleared_at: string | null;
  message: string;
}

interface ManualFixture {
  document_id: string;
  title: string;
  vendor: string;
  model: string;
  manual_version: string;
  effective_date: string | null;
  file: string;
  withdrawn?: boolean;
}

export interface SeedSummary {
  equipment: number;
  sources: number;
  alarms: number;
  documents: number;
  chunks: number;
  skippedKnowledge: boolean;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function demoSourceDefinitions(
  workspaceId: string,
  dataMode: DataMode,
): DiagnosisSource[] {
  const mockStatus = dataMode === 'mock' ? 'mock' : 'configured';
  return [
    {
      id: 'src-scada',
      workspace_id: workspaceId,
      kind: 'scada',
      name: 'SCADA / 实时测点',
      data_mode: dataMode,
      status: dataMode === 'live' ? 'unconfigured' : mockStatus,
      auth_kind: dataMode === 'live' ? 'token' : 'none',
      last_test_at: null,
      last_test_ok: null,
      notes:
        dataMode === 'live'
          ? 'Live 模式需要配置 DIAGNOSIS_REST_BASE_URL 与只读令牌；未配置时不会回退 Mock。'
          : '内置 Mock 来源，用于演示和离线回归。',
    },
    {
      id: 'src-mes',
      workspace_id: workspaceId,
      kind: 'mes',
      name: 'MES 事件',
      data_mode: dataMode,
      status: dataMode === 'live' ? 'unconfigured' : mockStatus,
      auth_kind: dataMode === 'live' ? 'token' : 'none',
      last_test_at: null,
      last_test_ok: null,
      notes:
        dataMode === 'live' ? '等待企业 MES 只读接口。' : '内置 Mock 来源。',
    },
    {
      id: 'src-wo',
      workspace_id: workspaceId,
      kind: 'work_order',
      name: '工单系统',
      data_mode: dataMode,
      status: dataMode === 'live' ? 'unconfigured' : mockStatus,
      auth_kind: dataMode === 'live' ? 'token' : 'none',
      last_test_at: null,
      last_test_ok: null,
      notes:
        dataMode === 'live' ? '等待企业工单只读接口。' : '内置 Mock 来源。',
    },
    {
      id: 'src-rootcloud',
      workspace_id: workspaceId,
      kind: 'rootcloud',
      name: '根云平台',
      // 根云是企业实时接口，未配置时不能标记为 mock，避免把模拟数据误认为真实来源。
      data_mode: 'live',
      status: 'unconfigured',
      auth_kind: 'signature',
      last_test_at: null,
      last_test_ok: null,
      notes:
        '根云专有接口未配置。没有企业文档/账号时仅保留字段映射模板，绝不猜测签名算法或伪造 endpoint。',
    },
    {
      id: 'src-manual',
      workspace_id: workspaceId,
      kind: 'manual',
      name: '设备手册库',
      data_mode: dataMode,
      status: 'configured',
      auth_kind: 'none',
      last_test_at: null,
      last_test_ok: null,
      notes: '本地 PDF/MD 导入，保留文件 hash、机型、版本与页级定位。',
    },
    {
      id: 'src-case',
      workspace_id: workspaceId,
      kind: 'case',
      name: '历史案例库',
      data_mode: dataMode,
      status: 'configured',
      auth_kind: 'none',
      last_test_at: null,
      last_test_ok: null,
      notes: '历史案例仅作参考，相似性不等于本次根因。',
    },
  ];
}

export async function seedDiagnosis(input: {
  repo: DiagnosisRepository;
  knowledge: KnowledgeService;
  workspaceId: string;
  fixturesDir: string;
  dataMode?: DataMode;
  skipKnowledge?: boolean;
}): Promise<SeedSummary> {
  const dataMode = input.dataMode ?? 'mock';
  const equipmentFile = path.join(input.fixturesDir, 'sources/equipment.json');
  const alarmsFile = path.join(input.fixturesDir, 'sources/alarms.json');
  const manualsFile = path.join(input.fixturesDir, 'manuals/manuals.json');
  const equipment = readJson<{ equipment: EquipmentFixture[] }>(equipmentFile);
  for (const item of equipment.equipment) {
    input.repo.upsertEquipment(input.workspaceId, {
      ...item,
      manual_document_id: item.manual_document_id ?? null,
      manual_version: item.manual_version ?? null,
    });
  }
  const sources = demoSourceDefinitions(input.workspaceId, dataMode);
  for (const source of sources)
    input.repo.upsertSource(input.workspaceId, source);

  let alarms = 0;
  if (fs.existsSync(alarmsFile)) {
    const parsed = readJson<{ alarms: AlarmFixture[] }>(alarmsFile);
    for (const item of parsed.alarms) {
      const idempotencyKey = `${item.source_id}|${item.source_alarm_id}|${item.raised_at}`;
      input.repo.upsertAlarm({
        id: stableScopedId('alm', input.workspaceId, idempotencyKey),
        workspaceId: input.workspaceId,
        sourceId: item.source_id,
        sourceAlarmId: item.source_alarm_id,
        equipmentId: item.equipment_id,
        code: item.code,
        severity: item.severity,
        state: item.state,
        raisedAt: item.raised_at,
        clearedAt: item.cleared_at,
        message: item.message,
        dataMode,
        idempotencyKey,
        scenarioId: null,
      });
      alarms += 1;
    }
  }

  let documents = 0;
  let chunks = 0;
  if (!input.skipKnowledge && fs.existsSync(manualsFile)) {
    const parsed = readJson<{ documents: ManualFixture[] }>(manualsFile);
    for (const document of parsed.documents) {
      const result = await input.knowledge.importFile({
        workspaceId: input.workspaceId,
        documentId: document.document_id,
        filePath: path.join(input.fixturesDir, document.file),
        title: document.title,
        vendor: document.vendor,
        model: document.model,
        manualVersion: document.manual_version,
        effectiveDate: document.effective_date,
      });
      input.repo.setDocumentWithdrawn(
        input.workspaceId,
        document.document_id,
        Boolean(document.withdrawn),
      );
      documents += 1;
      chunks += result.chunks;
    }
  }

  return {
    equipment: equipment.equipment.length,
    sources: sources.length,
    alarms,
    documents,
    chunks,
    skippedKnowledge: Boolean(input.skipKnowledge),
  };
}
