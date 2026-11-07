import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateDiagnosis } from '../../src/diagnosis/db.js';
import { DiagnosisEventBus } from '../../src/diagnosis/events.js';
import { FixtureRoleRunner } from '../../src/diagnosis/fixture-role-runner.js';
import { KnowledgeService } from '../../src/diagnosis/knowledge.js';
import { DiagnosisOrchestrator } from '../../src/diagnosis/orchestrator.js';
import { DiagnosisRepository } from '../../src/diagnosis/repository.js';
import { seedDiagnosis } from '../../src/diagnosis/seed.js';
import {
  DEFAULT_BUDGET,
  type Run,
} from '../../src/diagnosis/contracts/domain.js';
import { newId } from '../../src/diagnosis/util.js';

export const FIXTURES = path.resolve(process.cwd(), 'fixtures/diagnosis');

export interface TestContext {
  dir: string;
  db: Database.Database;
  repo: DiagnosisRepository;
  knowledge: KnowledgeService;
  orchestrator: DiagnosisOrchestrator;
  workspaceId: string;
  ftsAvailable: boolean;
}

export async function createSeededContext(
  prefix = 'diagnosis-test',
): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const migration = migrateDiagnosis(db, {
    backupDir: path.join(dir, 'backups'),
  });
  const repo = new DiagnosisRepository(db);
  const ftsAvailable = Boolean(
    migration.tokenizer && migration.tokenizer !== 'none',
  );
  const knowledge = new KnowledgeService(repo, {
    fixturesDir: FIXTURES,
    ftsAvailable,
  });
  const workspaceId = `ws-test-${Math.random().toString(36).slice(2, 10)}`;
  await seedDiagnosis({
    repo,
    knowledge,
    workspaceId,
    fixturesDir: FIXTURES,
  });
  const orchestrator = new DiagnosisOrchestrator({
    repo,
    knowledge,
    bus: new DiagnosisEventBus(),
    runner: new FixtureRoleRunner(),
    fixturesDir: FIXTURES,
  });
  return { dir, db, repo, knowledge, orchestrator, workspaceId, ftsAvailable };
}

export function closeContext(context: TestContext): void {
  try {
    context.db.close();
  } finally {
    fs.rmSync(context.dir, { recursive: true, force: true });
  }
}

export interface DemoScenario {
  id: string;
  device: string;
  start: string;
  symptom: string;
  expected: string[];
  handoff: boolean;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'demo-sensor-drift',
    device: 'EQ-DEMO-001',
    start: '2026-11-07T00:00:00.000Z',
    symptom: '1号循环泵轴承温度持续上升，振动与电流稳定',
    expected: ['sensor_drift'],
    handoff: false,
  },
  {
    id: 'demo-bearing-wear',
    device: 'EQ-DEMO-002',
    start: '2026-11-07T00:00:00.000Z',
    symptom: '2号循环泵振动与轴承温度同时上升，电流增大',
    expected: ['bearing_wear'],
    handoff: false,
  },
  {
    id: 'demo-false-alarm-comm',
    device: 'EQ-DEMO-003',
    start: '2026-11-07T00:00:00.000Z',
    symptom: '3号给水泵通讯报警，工艺参数正常',
    expected: ['false_alarm_comm'],
    handoff: false,
  },
  {
    id: 'demo-multi-fault',
    device: 'EQ-DEMO-001',
    start: '2026-11-07T01:00:00.000Z',
    symptom: '1号循环泵振动上升，同时温度出现与负荷不符的尖峰',
    expected: ['bearing_wear', 'sensor_drift'],
    handoff: false,
  },
  {
    id: 'demo-source-timeout',
    device: 'EQ-DEMO-002',
    start: '2026-11-07T02:00:00.000Z',
    symptom: '2号循环泵报警，但数据源超时',
    expected: ['insufficient_evidence'],
    handoff: true,
  },
];

export function isoPlus(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export async function runDemo(
  context: TestContext,
  demo: DemoScenario,
): Promise<Run> {
  const alarm = context.repo
    .listAlarms(context.workspaceId)
    .find((item) => item.source_alarm_id === `ALM-${demo.id}`);
  if (!alarm) throw new Error(`fixture alarm missing: ${demo.id}`);
  const run = context.repo.createRun({
    id: newId('run'),
    workspaceId: context.workspaceId,
    userId: 'test-user',
    alarmId: alarm.id,
    equipmentId: demo.device,
    window: {
      start: demo.start,
      end: isoPlus(demo.start, 30),
    },
    symptom: demo.symptom,
    dataMode: 'mock',
    modelMode: 'fixture',
    budget: DEFAULT_BUDGET,
    scenarioId: demo.id,
  });
  // 生产入口在创建 Run 时写入 run.created；测试辅助保持相同事件序列。
  context.repo.appendEvent(run.id, 'run.created', {
    workspace_id: context.workspaceId,
    equipment_id: run.equipment_id,
    alarm_id: run.alarm_id,
    data_mode: run.data_mode,
    model_mode: run.model_mode,
    scenario_id: demo.id,
  });
  return context.orchestrator.execute(run.id, { owner: 'test-worker' });
}
