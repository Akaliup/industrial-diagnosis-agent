import '../../src/diagnosis/load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateDiagnosis } from '../../src/diagnosis/db.js';
import { DiagnosisEventBus } from '../../src/diagnosis/events.js';
import { FixtureRoleRunner } from '../../src/diagnosis/fixture-role-runner.js';
import { KnowledgeService } from '../../src/diagnosis/knowledge.js';
import { DiagnosisOrchestrator } from '../../src/diagnosis/orchestrator.js';
import { DiagnosisRepository } from '../../src/diagnosis/repository.js';
import { seedDiagnosis } from '../../src/diagnosis/seed.js';
import { DEFAULT_BUDGET } from '../../src/diagnosis/contracts/domain.js';
import { newId } from '../../src/diagnosis/util.js';

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, 'fixtures/diagnosis');
const WORK = path.join(ROOT, 'work/diagnosis');
const DB_FILE = path.join(WORK, 'demo-smoke.db');

const DEMOS = [
  {
    id: 'demo-sensor-drift',
    device: 'EQ-DEMO-001',
    start: '2026-11-07T00:00:00.000Z',
    symptom: '1号循环泵轴承温度持续上升，振动与电流稳定',
    expect: ['sensor_drift'],
    handoff: false,
  },
  {
    id: 'demo-bearing-wear',
    device: 'EQ-DEMO-002',
    start: '2026-11-07T00:00:00.000Z',
    symptom: '2号循环泵振动与轴承温度同时上升，电流增大',
    expect: ['bearing_wear'],
    handoff: false,
  },
  {
    id: 'demo-false-alarm-comm',
    device: 'EQ-DEMO-003',
    start: '2026-11-07T00:00:00.000Z',
    symptom: '3号给水泵通讯报警，工艺参数正常',
    expect: ['false_alarm_comm'],
    handoff: false,
  },
  {
    id: 'demo-multi-fault',
    device: 'EQ-DEMO-001',
    start: '2026-11-07T01:00:00.000Z',
    symptom: '1号循环泵振动上升，同时温度出现与负荷不符的尖峰',
    expect: ['bearing_wear', 'sensor_drift'],
    handoff: false,
  },
  {
    id: 'demo-source-timeout',
    device: 'EQ-DEMO-002',
    start: '2026-11-07T02:00:00.000Z',
    symptom: '2号循环泵报警，但数据源超时',
    expect: ['insufficient_evidence'],
    handoff: true,
  },
];

function isoPlus(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

async function main(): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  fs.rmSync(DB_FILE, { force: true });
  const db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  const migration = migrateDiagnosis(db, {
    backupDir: path.join(WORK, 'backups'),
  });
  const repo = new DiagnosisRepository(db);
  const knowledge = new KnowledgeService(repo, {
    fixturesDir: FIXTURES,
    ftsAvailable: Boolean(
      migration.tokenizer && migration.tokenizer !== 'none',
    ),
  });
  const workspaceId = 'ws-demo-smoke';
  await seedDiagnosis({ repo, knowledge, workspaceId, fixturesDir: FIXTURES });
  const orchestrator = new DiagnosisOrchestrator({
    repo,
    knowledge,
    bus: new DiagnosisEventBus(),
    runner: new FixtureRoleRunner(),
    fixturesDir: FIXTURES,
  });

  let failures = 0;
  for (const demo of DEMOS) {
    const alarm = repo
      .listAlarms(workspaceId)
      .find((item) => item.source_alarm_id === `ALM-${demo.id}`);
    if (!alarm) throw new Error(`alarm not found for ${demo.id}`);
    const run = repo.createRun({
      id: newId('run'),
      workspaceId,
      userId: 'demo',
      alarmId: alarm.id,
      equipmentId: demo.device,
      window: { start: demo.start, end: isoPlus(demo.start, 30) },
      symptom: demo.symptom,
      dataMode: 'mock',
      modelMode: 'fixture',
      budget: DEFAULT_BUDGET,
      scenarioId: demo.id,
    });
    const finished = await orchestrator.execute(run.id, {
      owner: `demo-${demo.id}`,
    });
    const report = repo.getReport(run.id);
    const supported =
      report?.report.hypotheses
        .filter((item) => item.status === 'supported')
        .map((item) => item.code) ?? [];
    const contradicted =
      report?.report.hypotheses
        .filter((item) => item.status === 'contradicted')
        .map((item) => item.code) ?? [];
    const expectSet = new Set(demo.expect);
    const supportedSet = new Set(supported);
    const matched =
      expectSet.size === supportedSet.size &&
      [...expectSet].every((code) => supportedSet.has(code));
    const handoffOk = Boolean(report?.report.handoff_reason) === demo.handoff;
    if (!matched || !handoffOk) failures += 1;
    console.log(
      JSON.stringify(
        {
          scenario: demo.id,
          status: finished.status,
          stage: finished.stage,
          rounds: finished.total_rounds,
          logical_calls: finished.logical_calls,
          model_calls: finished.model_calls,
          expected: demo.expect,
          supported,
          contradicted,
          matched,
          handoff_expected: demo.handoff,
          handoff: report?.report.handoff_reason ?? null,
          handoff_ok: handoffOk,
          validation: report?.validation,
          conclusion: report?.report.conclusion_status,
          error: finished.error,
        },
        null,
        2,
      ),
    );
  }
  console.log(`failures=${failures}`);
  if (failures > 0) process.exitCode = 1;
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
