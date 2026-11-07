/**
 * 同步设备智诊领域协议。
 *
 * 唯一源：src/diagnosis/contracts/domain.ts
 * 生成物：
 *   - shared/diagnosis/contracts.ts
 *   - packages/industrial-diagnosis-mcp/src/contracts/domain.ts
 *   - web/src/diagnosis/contracts.generated.ts
 *   - packages/industrial-diagnosis-mcp/src/contracts/generated/schemas.json
 *   - shared/diagnosis/contracts.manifest.json
 *
 * 用法：
 *   tsx scripts/diagnosis/sync-contracts.ts
 *   tsx scripts/diagnosis/sync-contracts.ts --check
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AlarmSchema,
  CaseSearchDataSchema,
  CaseSearchInputSchema,
  DataInvestigatorOutputSchema,
  EquipmentQueryInputSchema,
  EquipmentResolveDataSchema,
  EquipmentResolveInputSchema,
  EquipmentStatusDataSchema,
  AlarmsDataSchema,
  EvidenceGetDataSchema,
  EvidenceGetInputSchema,
  HypothesisVerifierOutputSchema,
  KnowledgeRetrieverOutputSchema,
  ManualSearchDataSchema,
  ManualSearchInputSchema,
  ManualSectionDataSchema,
  ManualSectionInputSchema,
  MesEventsDataSchema,
  ReportReviewerOutputSchema,
  ReportSchema,
  RunEventSchema,
  RunSchema,
  TelemetryDataSchema,
  WorkOrdersDataSchema,
} from '../../src/diagnosis/contracts/domain.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const SOURCE = path.join(ROOT, 'src/diagnosis/contracts/domain.ts');
const HEADER = `/* eslint-disable */
/**
 * 自动生成，请勿手动修改。
 * 源文件：src/diagnosis/contracts/domain.ts
 * 重新生成：npm run diagnosis:sync-contracts
 */
`;
const COPIES = [
  'shared/diagnosis/contracts.ts',
  'packages/industrial-diagnosis-mcp/src/contracts/domain.ts',
  'web/src/diagnosis/contracts.generated.ts',
];
const SCHEMAS_PATH =
  'packages/industrial-diagnosis-mcp/src/contracts/generated/schemas.json';
const MANIFEST_PATH = 'shared/diagnosis/contracts.manifest.json';

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function buildSchemas(): string {
  const entries: Array<[string, z.ZodType]> = [
    ['equipment_resolve.input', EquipmentResolveInputSchema],
    ['equipment_resolve.output', EquipmentResolveDataSchema],
    ['equipment_query.input', EquipmentQueryInputSchema],
    ['equipment_query.status', EquipmentStatusDataSchema],
    ['equipment_query.telemetry', TelemetryDataSchema],
    ['equipment_query.alarms', AlarmsDataSchema],
    ['equipment_query.mes_events', MesEventsDataSchema],
    ['equipment_query.work_orders', WorkOrdersDataSchema],
    ['maintenance_search_manual.input', ManualSearchInputSchema],
    ['maintenance_search_manual.output', ManualSearchDataSchema],
    ['maintenance_get_manual_section.input', ManualSectionInputSchema],
    ['maintenance_get_manual_section.output', ManualSectionDataSchema],
    ['maintenance_search_cases.input', CaseSearchInputSchema],
    ['maintenance_search_cases.output', CaseSearchDataSchema],
    ['evidence_get.input', EvidenceGetInputSchema],
    ['evidence_get.output', EvidenceGetDataSchema],
    ['role.data_investigator', DataInvestigatorOutputSchema],
    ['role.knowledge_retriever', KnowledgeRetrieverOutputSchema],
    ['role.hypothesis_verifier', HypothesisVerifierOutputSchema],
    ['role.report_reviewer', ReportReviewerOutputSchema],
    ['domain.report', ReportSchema],
    ['domain.run', RunSchema],
    ['domain.run_event', RunEventSchema],
    ['domain.alarm', AlarmSchema],
  ];
  const out: Record<string, unknown> = {};
  for (const [name, schema] of entries) {
    out[name] = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    });
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

function write(rel: string, content: string): void {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function main(): void {
  const check = process.argv.includes('--check');
  const source = fs.readFileSync(SOURCE, 'utf8');
  const sourceHash = sha256(source);
  const copies: Record<string, string> = {};
  for (const rel of COPIES) copies[rel] = sha256(HEADER + source);
  const schemas = buildSchemas();
  copies[SCHEMAS_PATH] = sha256(schemas);
  const manifest = {
    source: 'src/diagnosis/contracts/domain.ts',
    source_sha256: sourceHash,
    generated: copies,
    generator: 'scripts/diagnosis/sync-contracts.ts',
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  if (check) {
    const problems: string[] = [];
    for (const rel of COPIES) {
      const expected = HEADER + source;
      if (!fs.existsSync(path.join(ROOT, rel))) problems.push(`missing ${rel}`);
      else if (read(rel) !== expected) problems.push(`stale ${rel}`);
    }
    if (!fs.existsSync(path.join(ROOT, SCHEMAS_PATH))) {
      problems.push(`missing ${SCHEMAS_PATH}`);
    } else if (read(SCHEMAS_PATH) !== schemas) {
      problems.push(`stale ${SCHEMAS_PATH}`);
    }
    if (!fs.existsSync(path.join(ROOT, MANIFEST_PATH))) {
      problems.push(`missing ${MANIFEST_PATH}`);
    } else {
      const current = JSON.parse(read(MANIFEST_PATH)) as typeof manifest;
      if (current.source_sha256 !== sourceHash) {
        problems.push('manifest source hash mismatch');
      }
    }
    if (problems.length > 0) {
      console.error('契约副本不一致：');
      for (const p of problems) console.error(` - ${p}`);
      console.error('运行 npm run diagnosis:sync-contracts 重新生成。');
      process.exit(1);
    }
    console.log(
      `契约一致：${sourceHash.slice(0, 12)} (${COPIES.length + 1} 个产物)`,
    );
    return;
  }

  for (const rel of COPIES) write(rel, HEADER + source);
  write(SCHEMAS_PATH, schemas);
  write(MANIFEST_PATH, manifestText);
  console.log(
    `已生成 ${COPIES.length + 2} 个产物，源 hash ${sourceHash.slice(0, 12)}`,
  );
}

main();
