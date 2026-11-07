/**
 * 初始化“设备智诊”演示数据（幂等）。
 *
 * 只写入诊断领域表与本地知识库；不会创建用户、不会设置默认密码，
 * 也不会修改 Miniclaw 主 Schema 版本。
 *
 * 用法：npm run diagnosis:setup
 * 环境变量：DIAGNOSIS_SETUP_WORKSPACE（默认 web:main）
 */
import '../../src/diagnosis/load-env.js';
import {
  closeDatabase,
  getDatabaseInstance,
  initDatabase,
} from '../../src/db.js';
import { DiagnosisRuntime } from '../../src/diagnosis/runtime.js';
import { seedDemoWorkspace } from '../../src/diagnosis/demo.js';

async function main(): Promise<void> {
  const workspaceId =
    process.env.DIAGNOSIS_SETUP_WORKSPACE?.trim() || 'web:main';
  initDatabase();
  const runtime = new DiagnosisRuntime(getDatabaseInstance(), {
    fixturesDir: process.env.DIAGNOSIS_FIXTURES_DIR ?? 'fixtures/diagnosis',
    modelMode: 'fixture',
    dataMode: 'mock',
    startWorker: false,
  });
  const result = await seedDemoWorkspace(runtime, workspaceId);
  console.log(
    JSON.stringify(
      {
        workspace_id: workspaceId,
        seed: result.seed,
        demo_alarms: result.demo_alarms.map((alarm) => ({
          id: alarm.id,
          code: alarm.code,
          equipment_id: alarm.equipment_id,
          scenario_id: alarm.scenario_id,
        })),
        note: '演示数据为虚构模拟数据；真实企业来源仍需单独配置。',
      },
      null,
      2,
    ),
  );
  closeDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
