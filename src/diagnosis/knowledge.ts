import fs from 'node:fs';
import path from 'node:path';
import type {
  CaseSearchData,
  CaseSearchInput,
  Coverage,
  DataMode,
  EvidenceDraft,
  ManualSearchData,
  ManualSearchInput,
  ManualSectionData,
  ManualSectionInput,
  RootCauseCode,
  ToolResult,
  ToolWarning,
} from './contracts/domain.js';
import type { DiagnosisRepository, KnowledgeHit } from './repository.js';
import { canonicalJson, nowIso, sha256 } from './util.js';

interface LocalCase {
  case_id: string;
  title: string;
  equipment_model: string;
  asset_category: string;
  occurred_at: string;
  root_cause_code: string;
  summary: string;
}

export interface ImportResult {
  documentId: string;
  status: 'indexed' | 'OCR_REQUIRED' | 'FAILED';
  chunks: number;
  pages: number;
  error?: string;
}

export interface KnowledgeContext {
  workspaceId: string;
  runId: string;
  dataMode: DataMode;
  query: unknown;
  /** 场景回放中撤回的文档不参与新检索，历史报告仍保留引用。 */
  withdrawnDocuments?: string[];
}

function coverage(from: string, to: string, complete = true): Coverage {
  return { from, to, complete, missing: [] };
}

function buildEvidence(
  ctx: KnowledgeContext,
  input: {
    sourceId: string;
    sourceKind: 'manual' | 'case';
    observedAt: string | null;
    sourceRecordId: string;
    locator: { kind: 'file' | 'db'; ref: string; page?: number };
    payload: EvidenceDraft['payload'];
  },
): EvidenceDraft {
  const payloadHash = sha256(canonicalJson(input.payload));
  const id = `ev_${sha256(
    `${ctx.workspaceId}|${ctx.runId}|${input.sourceId}|${input.sourceRecordId}|${payloadHash}`,
  ).slice(0, 20)}`;
  return {
    id,
    workspace_id: ctx.workspaceId,
    run_id: ctx.runId,
    source_id: input.sourceId,
    source_kind: input.sourceKind,
    data_mode: ctx.dataMode,
    equipment_id: null,
    observed_at: input.observedAt,
    fetched_at: nowIso(),
    source_record_id: input.sourceRecordId,
    payload_hash: payloadHash,
    query_hash: sha256(canonicalJson(ctx.query)),
    locator: input.locator,
    quality_flags: ['good'],
    payload: input.payload,
  };
}

function scoreText(text: string, query: string): number {
  const hay = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const tokens = new Set(q.split(/[\s,，。;；、/]+/).filter(Boolean));
  if (tokens.size === 1) {
    const single = [...tokens][0] ?? '';
    const chars = [...single];
    if (chars.length >= 2 && /[一-鿿]/.test(single)) {
      for (let i = 0; i < chars.length - 1; i += 1) {
        tokens.add(chars[i] + chars[i + 1]);
      }
    }
  }
  let hits = 0;
  for (const token of tokens) if (hay.includes(token)) hits += 1;
  return hits / Math.max(1, tokens.size);
}

async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  // 延迟加载，避免主服务启动时承担 pdfjs 的初始化成本。
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => {
        if (!('str' in item)) return '';
        return `${item.str}${item.hasEOL ? '\n' : ' '}`;
      })
      .join('')
      .replaceAll(/[ \t]+/g, ' ')
      .replaceAll(/ *\n */g, '\n')
      .replaceAll(/\n{3,}/g, '\n\n')
      .trim();
    pages.push(text);
  }
  return pages;
}

function parseTextPages(text: string, ext: '.md' | '.txt'): string[] {
  if (ext === '.md') {
    const sections = text.split(/\n(?=##\s)/);
    return sections.map((s) => s.trim()).filter(Boolean);
  }
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pages: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).length > 1200 && current) {
      pages.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) pages.push(current);
  return pages;
}

function splitSections(
  text: string,
  page: number,
): Array<{ page: number; section: string | null; text: string }> {
  const headingOf = (value: string): string | null => {
    for (const line of value.split('\n')) {
      const normalized = line.replace(/^#+\s*/, '').trim();
      const match = normalized.match(/^(\d+\.\d+\s+[^.]{1,80})/);
      if (match) return match[1].trim();
    }
    return null;
  };
  const parts = text.split(/\n(?=(?:#+\s*)?\d+\.\d+\s)/);
  if (parts.length <= 1) {
    return [{ page, section: headingOf(text), text: text.trim() }];
  }
  return parts
    .map((part) => {
      const trimmed = part.trim();
      return { page, section: headingOf(trimmed), text: trimmed };
    })
    .filter((p) => p.text.length > 0);
}

export class KnowledgeService {
  private cases: LocalCase[] | null = null;

  constructor(
    private readonly repo: DiagnosisRepository,
    private readonly options: {
      fixturesDir: string;
      ftsAvailable: boolean;
      allowedRoots?: string[];
    },
  ) {}

  private allowedRoots(): string[] {
    const roots = [
      path.resolve(this.options.fixturesDir, 'manuals'),
      path.resolve('data/diagnosis/knowledge'),
      ...(this.options.allowedRoots ?? []),
    ];
    return roots.map((r) => path.resolve(r));
  }

  resolveAllowedPath(filePath: string): string {
    const abs = path.resolve(filePath);
    const allowed = this.allowedRoots().some(
      (root) => abs === root || abs.startsWith(`${root}${path.sep}`),
    );
    if (!allowed) {
      throw new Error(`文件路径不在允许的知识库目录内：${filePath}`);
    }
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${filePath}`);
    return abs;
  }

  async importFile(input: {
    workspaceId: string;
    documentId: string;
    filePath: string;
    title: string;
    vendor: string;
    model: string;
    manualVersion: string;
    effectiveDate: string | null;
  }): Promise<ImportResult> {
    const abs = this.resolveAllowedPath(input.filePath);
    const buffer = fs.readFileSync(abs);
    const hash = sha256(buffer);
    const ext = path.extname(abs).toLowerCase();
    let pages: string[] = [];
    let parserVersion = 'text-v1';
    if (ext === '.pdf') {
      parserVersion = 'pdfjs-dist@4.10.38';
      pages = await extractPdfPages(buffer);
    } else if (ext === '.md' || ext === '.txt') {
      pages = parseTextPages(buffer.toString('utf8'), ext);
    } else {
      throw new Error(`不支持的文档类型：${ext}；仅支持 PDF/MD/TXT`);
    }
    const totalChars = pages.reduce((sum, p) => sum + p.length, 0);
    const scanned = ext === '.pdf' && totalChars < pages.length * 10;
    const relative = path.relative(process.cwd(), abs).replaceAll('\\', '/');
    this.repo.upsertDocument({
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      title: input.title,
      vendor: input.vendor,
      model: input.model,
      manualVersion: input.manualVersion,
      effectiveDate: input.effectiveDate,
      fileHash: hash,
      filePath: relative,
      parserVersion,
      status: scanned ? 'OCR_REQUIRED' : 'indexed',
    });
    if (scanned) {
      this.repo.replaceChunks(
        input.workspaceId,
        input.documentId,
        [],
        this.options.ftsAvailable,
      );
      return {
        documentId: input.documentId,
        status: 'OCR_REQUIRED',
        chunks: 0,
        pages: pages.length,
        error: '扫描 PDF 没有文字层，需要 OCR；未建立索引',
      };
    }
    const chunks: Array<{
      chunkId: string;
      documentId: string;
      page: number;
      printedPage: string | null;
      section: string | null;
      text: string;
      models: string[];
      version: string;
    }> = [];
    let index = 0;
    for (const [pageIndex, pageText] of pages.entries()) {
      for (const part of splitSections(pageText, pageIndex + 1)) {
        index += 1;
        chunks.push({
          chunkId: `${input.documentId}-P${part.page}-${index}`,
          documentId: input.documentId,
          page: part.page,
          printedPage: null,
          section: part.section,
          text: part.text,
          models: [input.model],
          version: input.manualVersion,
        });
      }
    }
    this.repo.replaceChunks(
      input.workspaceId,
      input.documentId,
      chunks,
      this.options.ftsAvailable,
    );
    return {
      documentId: input.documentId,
      status: 'indexed',
      chunks: chunks.length,
      pages: pages.length,
    };
  }

  private hitToResult(
    ctx: KnowledgeContext,
    hit: KnowledgeHit,
  ): { data: ManualSearchData['hits'][number]; evidence: EvidenceDraft } {
    const evidence = buildEvidence(ctx, {
      sourceId: 'src-manual',
      sourceKind: 'manual',
      observedAt: hit.document.effective_date
        ? `${hit.document.effective_date}T00:00:00Z`
        : null,
      sourceRecordId: `manual:${hit.document.document_id}:${hit.chunk.chunk_id}`,
      locator: {
        kind: 'file',
        ref: hit.document.file_path,
        page: hit.chunk.page,
      },
      payload: {
        kind: 'manual_chunk',
        document_id: hit.document.document_id,
        file_hash: hit.document.file_hash,
        vendor: hit.document.vendor,
        model: hit.document.model,
        manual_version: hit.document.manual_version,
        effective_date: hit.document.effective_date,
        chapter: null,
        section: hit.chunk.section,
        pdf_page_index: hit.chunk.page,
        printed_page: hit.chunk.printed_page,
        excerpt: hit.chunk.text,
      },
    });
    return {
      evidence,
      data: {
        document_id: hit.document.document_id,
        chunk_id: hit.chunk.chunk_id,
        title: hit.document.title,
        vendor: hit.document.vendor,
        model: hit.document.model,
        manual_version: hit.document.manual_version,
        effective_date: hit.document.effective_date,
        page: hit.chunk.page,
        printed_page: hit.chunk.printed_page,
        section: hit.chunk.section,
        excerpt: hit.chunk.text,
        score: Number(hit.score.toFixed(3)),
        file_hash: hit.document.file_hash,
      },
    };
  }

  searchManual(
    input: ManualSearchInput,
    ctx: KnowledgeContext,
  ): ToolResult<ManualSearchData> {
    const from = '2000-01-01T00:00:00Z';
    const to = nowIso();
    try {
      const hits = this.repo.searchChunks({
        workspaceId: ctx.workspaceId,
        query: input.query,
        model: input.equipment_model,
        version: input.manual_version,
        limit: input.limit ?? 5,
        ftsAvailable: this.options.ftsAvailable,
        excludeDocuments: ctx.withdrawnDocuments,
      });
      if (hits.length === 0) {
        return {
          status: 'no_data',
          data: null,
          evidence: [],
          coverage: coverage(from, to),
          warnings: [
            {
              code: input.equipment_model
                ? 'NO_COMPATIBLE_MANUAL'
                : 'NO_MANUAL_MATCH',
              message: input.equipment_model
                ? `没有与机型 ${input.equipment_model} 显式兼容的手册条款`
                : '没有匹配的手册条款',
            },
          ],
          error: null,
          next_cursor: null,
        };
      }
      const mapped = hits.map((hit) => this.hitToResult(ctx, hit));
      const warnings: ToolWarning[] = [];
      if (!input.manual_version) {
        warnings.push({
          code: 'VERSION_UNSPECIFIED',
          message: '未指定手册版本，命中条款需人工确认适用版本',
        });
      }
      return {
        status: input.manual_version ? 'success' : 'partial',
        data: { hits: mapped.map((m) => m.data) },
        evidence: mapped.map((m) => m.evidence),
        coverage: coverage(from, to),
        warnings,
        error: null,
        next_cursor: null,
      };
    } catch (error) {
      return {
        status: 'error',
        data: null,
        evidence: [],
        coverage: coverage(from, to, false),
        warnings: [],
        error: {
          code: 'SOURCE_UNAVAILABLE',
          retryable: false,
          safe_message: error instanceof Error ? error.message : String(error),
        },
        next_cursor: null,
      };
    }
  }

  getManualSection(
    input: ManualSectionInput,
    ctx: KnowledgeContext,
  ): ToolResult<ManualSectionData> {
    const from = '2000-01-01T00:00:00Z';
    const to = nowIso();
    if (ctx.withdrawnDocuments?.includes(input.document_id)) {
      return {
        status: 'no_data',
        data: null,
        evidence: [],
        coverage: coverage(from, to),
        warnings: [
          {
            code: 'DOCUMENT_WITHDRAWN',
            message: `文档 ${input.document_id} 已撤回，不参与新检索`,
          },
        ],
        error: null,
        next_cursor: null,
      };
    }
    const hit = this.repo.getChunk(
      ctx.workspaceId,
      input.document_id,
      input.chunk_id,
      input.page,
    );
    if (!hit) {
      return {
        status: 'no_data',
        data: null,
        evidence: [],
        coverage: coverage(from, to),
        warnings: [{ code: 'NOT_FOUND', message: '未找到对应手册条款' }],
        error: null,
        next_cursor: null,
      };
    }
    const mapped = this.hitToResult(ctx, hit);
    return {
      status: 'success',
      data: {
        document_id: mapped.data.document_id,
        chunk_id: mapped.data.chunk_id,
        title: mapped.data.title,
        vendor: mapped.data.vendor,
        model: mapped.data.model,
        manual_version: mapped.data.manual_version,
        effective_date: mapped.data.effective_date,
        page: mapped.data.page,
        printed_page: mapped.data.printed_page,
        section: mapped.data.section,
        excerpt: mapped.data.excerpt,
        file_hash: mapped.data.file_hash,
      },
      evidence: [mapped.evidence],
      coverage: coverage(from, to),
      warnings: [],
      error: null,
      next_cursor: null,
    };
  }

  private loadCases(): LocalCase[] {
    if (this.cases) return this.cases;
    const file = path.join(this.options.fixturesDir, 'cases/cases.json');
    if (!fs.existsSync(file)) {
      this.cases = [];
      return this.cases;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      cases: LocalCase[];
    };
    this.cases = parsed.cases ?? [];
    return this.cases;
  }

  searchCases(
    input: CaseSearchInput,
    ctx: KnowledgeContext,
  ): ToolResult<CaseSearchData> {
    const from = '2000-01-01T00:00:00Z';
    const to = nowIso();
    const results = this.loadCases()
      .filter(
        (c) =>
          (!input.equipment_model ||
            c.equipment_model === input.equipment_model) &&
          (!input.asset_category || c.asset_category === input.asset_category),
      )
      .map((record) => ({
        record,
        score: scoreText(`${record.title} ${record.summary}`, input.query),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? 5);
    if (results.length === 0) {
      return {
        status: 'no_data',
        data: null,
        evidence: [],
        coverage: coverage(from, to),
        warnings: [{ code: 'NO_CASE_MATCH', message: '没有匹配的历史案例' }],
        error: null,
        next_cursor: null,
      };
    }
    const evidence = results.map(({ record }) =>
      buildEvidence(ctx, {
        sourceId: 'src-case',
        sourceKind: 'case',
        observedAt: record.occurred_at,
        sourceRecordId: `case:${record.case_id}`,
        locator: { kind: 'db', ref: `cases/${record.case_id}` },
        payload: {
          kind: 'case_record',
          case_id: record.case_id,
          title: record.title,
          equipment_model: record.equipment_model,
          asset_category: record.asset_category,
          occurred_at: record.occurred_at,
          root_cause_code: record.root_cause_code as RootCauseCode,
          summary: record.summary,
        },
      }),
    );
    return {
      status: 'success',
      data: {
        hits: results.map(({ record }) => ({
          case_id: record.case_id,
          title: record.title,
          equipment_model: record.equipment_model,
          asset_category: record.asset_category,
          occurred_at: record.occurred_at,
          root_cause_code: record.root_cause_code as RootCauseCode,
          summary: record.summary,
          similarity_note: '历史相似性不等于本次根因，仅作参考',
        })),
      },
      evidence,
      coverage: coverage(from, to),
      warnings: [],
      error: null,
      next_cursor: null,
    };
  }
}
