import path from 'node:path';
import { migrateDiagnosis, type DiagnosisDb } from './db.js';
import { DiagnosisEventBus } from './events.js';
import { FixtureRoleRunner } from './fixture-role-runner.js';
import { KnowledgeService } from './knowledge.js';
import { createRoleRunner } from './live-role-runner.js';
import { DiagnosisOrchestrator } from './orchestrator.js';
import { DiagnosisRepository } from './repository.js';
import { seedDiagnosis, type SeedSummary } from './seed.js';
import { DiagnosisWorker } from './worker.js';
import type { DataMode, ModelMode } from './contracts/domain.js';
import type { RoleRunner } from './role-runner.js';

export interface DiagnosisRuntimeOptions {
  fixturesDir?: string;
  modelMode?: ModelMode;
  dataMode?: DataMode;
  /** 是否创建并启动后台 Worker；独立服务为 true，单元测试默认 false。 */
  startWorker?: boolean;
  workerConcurrency?: number;
  workerPollIntervalMs?: number;
  leaseMs?: number;
  backupDir?: string;
  logDir?: string;
  mcpServerPath?: string;
  roleRunner?: RoleRunner;
}

/**
 * 设备智诊运行时：在 IndustrialDiagnosis 主数据库连接上挂载领域表与服务。
 *
 * 不修改主服务 Schema/迁移版本；诊断表使用独立的 diagnosis_meta 版本。
 * Worker 与 Web/API 共享同一 SQLite 连接（WAL），写操作通过 better-sqlite3
 * 同步事务串行化。
 */
export class DiagnosisRuntime {
  readonly repo: DiagnosisRepository;
  readonly knowledge: KnowledgeService;
  readonly bus: DiagnosisEventBus;
  readonly runner: RoleRunner;
  readonly orchestrator: DiagnosisOrchestrator;
  readonly worker: DiagnosisWorker;
  readonly fixturesDir: string;
  readonly modelMode: ModelMode;
  readonly dataMode: DataMode;
  readonly ftsTokenizer: string | null;

  constructor(db: DiagnosisDb, options: DiagnosisRuntimeOptions = {}) {
    const migration = migrateDiagnosis(db, {
      backupDir: options.backupDir ?? path.join('work/diagnosis/backups'),
    });
    this.ftsTokenizer = migration.tokenizer;
    this.fixturesDir = path.resolve(
      options.fixturesDir ?? 'fixtures/diagnosis',
    );
    this.modelMode = options.modelMode ?? 'fixture';
    this.dataMode = options.dataMode ?? 'mock';
    this.repo = new DiagnosisRepository(db);
    this.knowledge = new KnowledgeService(this.repo, {
      fixturesDir: this.fixturesDir,
      ftsAvailable: Boolean(
        migration.tokenizer && migration.tokenizer !== 'none',
      ),
    });
    this.bus = new DiagnosisEventBus();
    this.runner =
      options.roleRunner ??
      (this.modelMode === 'fixture'
        ? new FixtureRoleRunner()
        : createRoleRunner('live'));
    this.orchestrator = new DiagnosisOrchestrator({
      repo: this.repo,
      knowledge: this.knowledge,
      bus: this.bus,
      runner: this.runner,
      fixturesDir: this.fixturesDir,
      mcpServerPath: options.mcpServerPath,
      leaseMs: options.leaseMs,
      logDir: options.logDir,
    });
    this.worker = new DiagnosisWorker({
      repo: this.repo,
      orchestrator: this.orchestrator,
      concurrency: options.workerConcurrency,
      pollIntervalMs: options.workerPollIntervalMs,
      leaseMs: options.leaseMs,
    });
    if (options.startWorker) this.worker.start();
  }

  async seed(
    workspaceId: string,
    dataMode: DataMode = this.dataMode,
  ): Promise<SeedSummary> {
    return seedDiagnosis({
      repo: this.repo,
      knowledge: this.knowledge,
      workspaceId,
      fixturesDir: this.fixturesDir,
      dataMode,
    });
  }

  async close(): Promise<void> {
    await this.worker.stop();
  }
}

export function modelModeFromEnv(): ModelMode {
  return process.env.DIAGNOSIS_MODEL_MODE === 'live' ? 'live' : 'fixture';
}

export function dataModeFromEnv(): DataMode {
  const value = process.env.DIAGNOSIS_DATA_MODE;
  if (value === 'live' || value === 'replay' || value === 'mock') return value;
  return 'mock';
}
