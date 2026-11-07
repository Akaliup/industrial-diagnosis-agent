import fs from 'node:fs';
import path from 'node:path';
import type { Alarm } from './contracts/domain.js';
import type { DiagnosisRuntime } from './runtime.js';
import type { SeedSummary } from './seed.js';
import { sha256 } from './util.js';

interface DemoManifest {
  demo_scenarios?: Array<{
    id: string;
    equipment_id: string;
    alarm_code: string;
    symptom: string;
  }>;
}

interface DemoScenarioOverlay {
  alarms?: Array<{
    source_id: string;
    source_alarm_id: string;
    equipment_id: string;
    code: string;
    severity: string;
    state: string;
    raised_at: string;
    cleared_at: string | null;
    message: string;
  }>;
}

export interface DemoSeedResult {
  seed: SeedSummary;
  demo_alarms: Alarm[];
}

/**
 * 写入演示数据，并把场景覆盖绑定到同一条基础报警上。
 * Web API 与命令行初始化共用此实现，避免两套幂等键产生重复报警。
 */
export async function seedDemoWorkspace(
  runtime: DiagnosisRuntime,
  workspaceId: string,
): Promise<DemoSeedResult> {
  const summary = await runtime.seed(workspaceId, 'mock');
  const manifestPath = path.join(runtime.fixturesDir, 'manifest.json');
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf8'),
  ) as DemoManifest;
  const demoAlarms: Alarm[] = [];
  for (const demo of manifest.demo_scenarios ?? []) {
    const scenarioPath = path.join(
      runtime.fixturesDir,
      'scenarios',
      `${demo.id}.json`,
    );
    if (!fs.existsSync(scenarioPath)) continue;
    const overlay = JSON.parse(
      fs.readFileSync(scenarioPath, 'utf8'),
    ) as DemoScenarioOverlay;
    const alarm = overlay.alarms?.[0];
    if (!alarm) continue;
    // 基础种子已写入同一条报警；演示场景只补 scenario_id，避免收件箱重复。
    const idempotencyKey = `${alarm.source_id}|${alarm.source_alarm_id}|${alarm.raised_at}`;
    const stored = runtime.repo.upsertAlarm({
      id: `alm_${sha256(idempotencyKey).slice(0, 20)}`,
      workspaceId,
      sourceId: alarm.source_id,
      sourceAlarmId: alarm.source_alarm_id,
      equipmentId: alarm.equipment_id,
      code: alarm.code,
      severity: alarm.severity,
      state: alarm.state,
      raisedAt: alarm.raised_at,
      clearedAt: alarm.cleared_at,
      message: alarm.message,
      dataMode: 'mock',
      idempotencyKey,
      scenarioId: demo.id,
    });
    demoAlarms.push(stored.alarm);
  }
  return { seed: summary, demo_alarms: demoAlarms };
}
