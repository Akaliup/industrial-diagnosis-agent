import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateDiagnosis } from '../../src/diagnosis/db.js';
import { KnowledgeService } from '../../src/diagnosis/knowledge.js';
import { DiagnosisRepository } from '../../src/diagnosis/repository.js';
import { seedDiagnosis } from '../../src/diagnosis/seed.js';
import { sha256 } from '../../src/diagnosis/util.js';
import { FIXTURES } from './helpers.js';

let dir: string;
let db: Database.Database;
let repo: DiagnosisRepository;
let knowledge: KnowledgeService;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnosis-workspace-'));
  db = new Database(path.join(dir, 'test.db'));
  const migration = migrateDiagnosis(db, {
    backupDir: path.join(dir, 'backups'),
  });
  repo = new DiagnosisRepository(db);
  knowledge = new KnowledgeService(repo, {
    fixturesDir: FIXTURES,
    ftsAvailable: Boolean(
      migration.tokenizer && migration.tokenizer !== 'none',
    ),
  });
}, 120_000);

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace-scoped stable ids', () => {
  test('seeds alarms in two workspaces without primary-key collisions', async () => {
    await seedDiagnosis({
      repo,
      knowledge,
      workspaceId: 'scope-A',
      fixturesDir: FIXTURES,
      skipKnowledge: true,
    });
    await seedDiagnosis({
      repo,
      knowledge,
      workspaceId: 'scope-B',
      fixturesDir: FIXTURES,
      skipKnowledge: true,
    });
    expect(repo.listAlarms('scope-A')).toHaveLength(5);
    expect(repo.listAlarms('scope-B')).toHaveLength(5);
    const idsA = new Set(repo.listAlarms('scope-A').map((item) => item.id));
    for (const alarm of repo.listAlarms('scope-B')) {
      expect(idsA.has(alarm.id)).toBe(false);
    }
  });

  test('re-seeding is idempotent and preserves legacy alarm ids', async () => {
    const first = repo.listAlarms('scope-A');
    await seedDiagnosis({
      repo,
      knowledge,
      workspaceId: 'scope-A',
      fixturesDir: FIXTURES,
      skipKnowledge: true,
    });
    const second = repo.listAlarms('scope-A');
    expect(second.map((item) => item.id).sort()).toEqual(
      first.map((item) => item.id).sort(),
    );
    expect(second).toHaveLength(5);

    // 模拟升级前的全局报警 ID：同一 Workspace/幂等键必须复用旧行，而不是新增。
    const legacyKey = 'legacy|alarm|2026-11-07T00:00:00.000Z';
    const legacyId = `alm_${sha256(legacyKey).slice(0, 20)}`;
    repo.upsertAlarm({
      id: legacyId,
      workspaceId: 'scope-A',
      sourceId: 'src-scada',
      sourceAlarmId: 'LEGACY-1',
      equipmentId: 'EQ-DEMO-001',
      code: 'LEGACY',
      severity: 'low',
      state: 'active',
      raisedAt: '2026-11-07T00:00:00.000Z',
      clearedAt: null,
      message: 'legacy',
      dataMode: 'mock',
      idempotencyKey: legacyKey,
      scenarioId: null,
    });
    const before = repo.listAlarms('scope-A').length;
    repo.upsertAlarm({
      id: 'alm_new_should_not_be_used',
      workspaceId: 'scope-A',
      sourceId: 'src-scada',
      sourceAlarmId: 'LEGACY-1',
      equipmentId: 'EQ-DEMO-001',
      code: 'LEGACY',
      severity: 'low',
      state: 'active',
      raisedAt: '2026-11-07T00:00:00.000Z',
      clearedAt: null,
      message: 'legacy',
      dataMode: 'mock',
      idempotencyKey: legacyKey,
      scenarioId: null,
    });
    expect(repo.listAlarms('scope-A')).toHaveLength(before);
    expect(
      repo.listAlarms('scope-A').some((item) => item.id === legacyId),
    ).toBe(true);
  });

  test('imports the same manual into two workspaces without chunk id collisions', async () => {
    const file = path.join(FIXTURES, 'manuals/np200-v2-zh.md');
    for (const workspaceId of ['scope-A', 'scope-B']) {
      await knowledge.importFile({
        workspaceId,
        documentId: 'DOC-SCOPE-TEST',
        filePath: file,
        title: 'scope test',
        vendor: 'V',
        model: 'NP-200',
        manualVersion: 'v2',
        effectiveDate: '2024-07-01',
      });
    }
    const count = (workspaceId: string): number => {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS n FROM knowledge_chunks WHERE workspace_id=?',
        )
        .get(workspaceId) as { n: number };
      return row.n;
    };
    expect(count('scope-A')).toBeGreaterThan(0);
    expect(count('scope-B')).toBeGreaterThan(0);
    const idsA = db
      .prepare('SELECT chunk_id FROM knowledge_chunks WHERE workspace_id=?')
      .all('scope-A') as Array<{ chunk_id: string }>;
    const idsB = new Set(
      (
        db
          .prepare('SELECT chunk_id FROM knowledge_chunks WHERE workspace_id=?')
          .all('scope-B') as Array<{ chunk_id: string }>
      ).map((row) => row.chunk_id),
    );
    for (const row of idsA) expect(idsB.has(row.chunk_id)).toBe(false);
  });
});
