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
const DB_FILE = path.join(WORK, 'smoke.db');

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
  const workspaceId = 'ws-smoke';
  const seeded = await seedDiagnosis({
    repo,
    knowledge,
    workspaceId,
    fixturesDir: FIXTURES,
  });
  console.log('seeded', seeded);

  const alarms = repo.listAlarms(workspaceId);
  const alarm = alarms.find(
    (item) => item.source_alarm_id === 'ALM-demo-sensor-drift',
  );
  if (!alarm) throw new Error('demo alarm not found');

  const run = repo.createRun({
    id: newId('run'),
    workspaceId,
    userId: 'smoke',
    alarmId: alarm.id,
    equipmentId: alarm.equipment_id,
    window: {
      start: '2026-11-07T00:00:00.000Z',
      end: '2026-11-07T00:30:00.000Z',
    },
    symptom: '1号循环泵轴承温度持续上升，振动与电流稳定',
    dataMode: 'mock',
    modelMode: 'fixture',
    budget: DEFAULT_BUDGET,
    scenarioId: 'demo-sensor-drift',
  });

  const orchestrator = new DiagnosisOrchestrator({
    repo,
    knowledge,
    bus: new DiagnosisEventBus(),
    runner: new FixtureRoleRunner(),
    fixturesDir: FIXTURES,
  });
  const finished = await orchestrator.execute(run.id, { owner: 'smoke' });
  console.log('run', {
    id: finished.id,
    status: finished.status,
    stage: finished.stage,
    conclusion: finished.conclusion_status,
    handoff: finished.handoff_reason,
    rounds: finished.total_rounds,
    logical_calls: finished.logical_calls,
    model_calls: finished.model_calls,
    tokens: [finished.input_tokens, finished.output_tokens],
    error: finished.error,
  });
  const stored = repo.getReport(run.id);
  if (!stored) {
    console.error('no report');
    process.exitCode = 1;
  } else {
    console.log(
      'report',
      JSON.stringify(
        {
          hypotheses: stored.report.hypotheses.map((h) => ({
            code: h.code,
            status: h.status,
            support: h.supporting_evidence_ids,
            contradict: h.contradicting_evidence_ids,
          })),
          observations: stored.report.observations.length,
          checks: stored.report.checks.length,
          recommendations: stored.report.recommendations.length,
          handoff: stored.report.handoff_reason,
          validation: stored.validation,
        },
        null,
        2,
      ),
    );
  }
  console.log(
    'evidence',
    repo.listEvidence(run.id).map((item) => ({
      id: item.id,
      kind: item.payload.kind,
      metric:
        item.payload.kind === 'telemetry_series'
          ? item.payload.metric
          : undefined,
    })),
  );
  console.log(
    'tool calls',
    repo.listToolCalls(run.id).map((row) => ({
      tool: row.tool,
      status: row.status,
      policy: row.policy_decision,
      error: row.error_code,
    })),
  );
  console.log(
    'events',
    repo.listEvents(run.id).map((event) => `${event.seq}:${event.type}`),
  );
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
