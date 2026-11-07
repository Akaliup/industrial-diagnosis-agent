import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  closeContext,
  createSeededContext,
  FIXTURES,
  type TestContext,
} from './helpers.js';
import { KnowledgeService } from '../../src/diagnosis/knowledge.js';

let context: TestContext;

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: context.workspaceId,
    runId: 'run_knowledge_test',
    dataMode: 'mock' as const,
    query: {},
    ...overrides,
  };
}

beforeAll(async () => {
  context = await createSeededContext('diagnosis-knowledge');
}, 120_000);

afterAll(() => {
  closeContext(context);
});

describe('diagnosis knowledge service', () => {
  test('finds Chinese manual clauses with page-level citations', () => {
    const result = context.knowledge.searchManual(
      {
        query: '轴承温度 传感器漂移',
        equipment_model: 'NP-200',
        manual_version: 'v2',
        limit: 5,
      },
      ctx(),
    );
    expect(result.status).toBe('success');
    const hits = result.data?.hits ?? [];
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.model).toBe('NP-200');
      expect(hit.manual_version).toBe('v2');
      expect(hit.page).toBeGreaterThanOrEqual(1);
      expect(hit.excerpt.length).toBeGreaterThan(0);
    }
    const evidence = result.evidence[0];
    expect(evidence.payload.kind).toBe('manual_chunk');
    if (evidence.payload.kind === 'manual_chunk') {
      expect(evidence.payload.model).toBe('NP-200');
      expect(evidence.payload.manual_version).toBe('v2');
      expect(evidence.payload.pdf_page_index).toBeGreaterThanOrEqual(1);
    }
  });

  test('recalls no-space Chinese compounds through the bigram fallback', () => {
    const result = context.knowledge.searchManual(
      {
        query: '轴承温度传感器漂移',
        equipment_model: 'NP-200',
        manual_version: 'v2',
        limit: 5,
      },
      ctx(),
    );
    expect(result.status).toBe('success');
    const hits = result.data?.hits ?? [];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => /传感器漂移|温度传感器/.test(hit.excerpt))).toBe(
      true,
    );
  });

  test('searches the English manual and keeps version scope', () => {
    const result = context.knowledge.searchManual(
      {
        query: 'bearing temperature sensor drift vibration',
        equipment_model: 'NP-200',
        manual_version: 'v2',
        limit: 5,
      },
      ctx(),
    );
    expect(result.status).toBe('success');
    const hits = result.data?.hits ?? [];
    expect(hits.length).toBeGreaterThan(0);
    const versions = new Set(hits.map((hit) => hit.manual_version));
    expect(versions.has('v2')).toBe(true);
    expect(
      hits.some((hit) => /Temperature sensor drift/i.test(hit.excerpt)),
    ).toBe(true);
  });

  test('returns no_data for incompatible equipment models', () => {
    const result = context.knowledge.searchManual(
      { query: '轴承温度', equipment_model: 'NP-999' },
      ctx(),
    );
    expect(result.status).toBe('no_data');
    expect(result.data).toBeNull();
    expect(result.warnings.map((item) => item.code)).toContain(
      'NO_COMPATIBLE_MANUAL',
    );
  });

  test('excludes withdrawn documents from new searches', () => {
    const result = context.knowledge.searchManual(
      {
        query: '轴承温度传感器漂移',
        equipment_model: 'NP-200',
        manual_version: 'v2',
      },
      ctx({ withdrawnDocuments: ['DOC-NP200-V2-ZH'] }),
    );
    const hits = result.data?.hits ?? [];
    expect(hits.some((hit) => hit.document_id === 'DOC-NP200-V2-ZH')).toBe(
      false,
    );
    const section = context.knowledge.getManualSection(
      { document_id: 'DOC-NP200-V2-ZH', chunk_id: 'DOC-NP200-V2-ZH-P3-3' },
      ctx({ withdrawnDocuments: ['DOC-NP200-V2-ZH'] }),
    );
    expect(section.status).toBe('no_data');
    expect(section.warnings.map((item) => item.code)).toContain(
      'DOCUMENT_WITHDRAWN',
    );
  });

  test('finds historical cases without treating similarity as proof', () => {
    const result = context.knowledge.searchCases(
      {
        query: 'NP-200 轴承磨损 温度漂移',
        equipment_model: 'NP-200',
        limit: 5,
      },
      ctx(),
    );
    expect(result.status).toBe('success');
    const hits = result.data?.hits ?? [];
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.equipment_model).toBe('NP-200');
    }
    const evidence = result.evidence[0];
    expect(evidence.payload.kind).toBe('case_record');
    if (evidence.payload.kind === 'case_record') {
      expect(evidence.payload.equipment_model).toBe('NP-200');
    }
  });

  test('marks textless PDFs as OCR_REQUIRED instead of indexing garbage', async () => {
    const dir = path.join(context.dir, 'ocr');
    fs.mkdirSync(dir, { recursive: true });
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const file = path.join(dir, 'scanned.pdf');
    fs.writeFileSync(file, await pdf.save());
    const knowledge = new KnowledgeService(context.repo, {
      fixturesDir: FIXTURES,
      ftsAvailable: context.ftsAvailable,
      allowedRoots: [dir],
    });
    const result = await knowledge.importFile({
      workspaceId: context.workspaceId,
      documentId: 'DOC-SCANNED-TEST',
      filePath: file,
      title: '扫描件测试',
      vendor: 'Test',
      model: 'NP-200',
      manualVersion: 'v1',
      effectiveDate: null,
    });
    expect(result.status).toBe('OCR_REQUIRED');
    expect(result.chunks).toBe(0);
    expect(result.error).toContain('OCR');
  }, 60_000);
});
