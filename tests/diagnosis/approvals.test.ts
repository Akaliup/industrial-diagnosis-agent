import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateDiagnosis } from '../../src/diagnosis/db.js';
import { DiagnosisRepository } from '../../src/diagnosis/repository.js';
import {
  approvalExpired,
  CONTROL_EXECUTION,
  receiptDisposition,
  selfApprovalForbidden,
} from '../../src/diagnosis/approval-policy.js';
import {
  DEFAULT_BUDGET,
  type Approval,
  type Run,
} from '../../src/diagnosis/contracts/domain.js';
import { newId } from '../../src/diagnosis/util.js';

let dir: string;
let db: Database.Database;
let repo: DiagnosisRepository;
let run: Run;

const NOW = Date.now();

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: newId('approval'),
    run_id: run.id,
    workspace_id: run.workspace_id,
    action_id: 'check_bearing_temperature',
    equipment_id: run.equipment_id,
    risk_level: 'control_intent',
    params_hash: 'a'.repeat(64),
    evidence_snapshot_hash: 'b'.repeat(64),
    requested_by: 'user_applicant',
    approved_by: null,
    status: 'pending',
    receipt_status: null,
    expires_at: new Date(NOW + 30 * 60_000).toISOString(),
    policy_version: 'diagnosis-policy-v1',
    created_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnosis-approval-'));
  db = new Database(path.join(dir, 'approval.db'));
  db.pragma('journal_mode = WAL');
  migrateDiagnosis(db, { backupDir: path.join(dir, 'backups') });
  repo = new DiagnosisRepository(db);
  run = repo.createRun({
    id: newId('run'),
    workspaceId: 'ws_approval',
    userId: 'user_applicant',
    alarmId: null,
    equipmentId: 'EQ-DEMO-001',
    window: {
      start: '2026-11-07T00:00:00.000Z',
      end: '2026-11-07T00:30:00.000Z',
    },
    symptom: 'approval test',
    dataMode: 'mock',
    modelMode: 'fixture',
    budget: DEFAULT_BUDGET,
    scenarioId: null,
  });
});

afterAll(() => {
  try {
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('approval policy', () => {
  test('forbids self approval only for high-risk control intents', () => {
    expect(
      selfApprovalForbidden(
        { requested_by: 'user_a', risk_level: 'control_intent' },
        'user_a',
      ),
    ).toBe(true);
    expect(
      selfApprovalForbidden(
        { requested_by: 'user_a', risk_level: 'control' },
        'user_a',
      ),
    ).toBe(true);
    expect(
      selfApprovalForbidden(
        { requested_by: 'user_a', risk_level: 'control_intent' },
        'user_b',
      ),
    ).toBe(false);
    expect(
      selfApprovalForbidden(
        { requested_by: 'user_a', risk_level: 'read' },
        'user_a',
      ),
    ).toBe(false);
  });

  test('expires approvals at the recorded deadline', () => {
    expect(
      approvalExpired({ expires_at: new Date(NOW - 1).toISOString() }, NOW),
    ).toBe(true);
    expect(
      approvalExpired({ expires_at: new Date(NOW + 1).toISOString() }, NOW),
    ).toBe(false);
    expect(approvalExpired({ expires_at: 'not-a-date' }, NOW)).toBe(true);
  });

  test('receipt status never implies the diagnosis service executed control', () => {
    expect(CONTROL_EXECUTION).toBe('disabled');
    expect(receiptDisposition(null)).toBe('no_receipt');
    expect(receiptDisposition('unknown')).toBe('unconfirmed');
    expect(receiptDisposition('failed')).toBe('failed');
    expect(receiptDisposition('submitted')).toBe('not_executed');
    expect(receiptDisposition('acknowledged')).toBe('not_executed');
  });

  test('repository records decision and immutable approval state', () => {
    const approval = makeApproval();
    repo.createApproval(approval);
    const pending = repo.getApproval(run.workspace_id, approval.id);
    expect(pending?.status).toBe('pending');
    expect(pending?.receipt_status).toBeNull();

    const approved = repo.decideApproval(
      run.workspace_id,
      approval.id,
      'user_approver',
      'approved',
    );
    expect(approved?.status).toBe('approved');
    expect(approved?.approved_by).toBe('user_approver');

    const again = repo.decideApproval(
      run.workspace_id,
      approval.id,
      'user_other',
      'rejected',
    );
    expect(again?.status).toBe('approved');
    expect(again?.approved_by).toBe('user_approver');
  });

  test('new recommendations invalidate pending approvals for the run', () => {
    const first = makeApproval();
    const second = makeApproval();
    repo.createApproval(first);
    repo.createApproval(second);
    repo.invalidateApprovals(run.id);
    expect(repo.getApproval(run.workspace_id, first.id)?.status).toBe(
      'invalidated',
    );
    expect(repo.getApproval(run.workspace_id, second.id)?.status).toBe(
      'invalidated',
    );
  });

  test('unknown receipts are stored without claiming execution', () => {
    const approval = makeApproval();
    repo.createApproval(approval);
    repo.setApprovalReceipt(approval.id, 'unknown');
    repo.createReceipt({
      id: newId('receipt'),
      approvalId: approval.id,
      status: 'unknown',
      payload: { note: '外部执行器未返回确认，按未执行处理' },
    });
    const stored = repo.getApproval(run.workspace_id, approval.id);
    expect(stored?.receipt_status).toBe('unknown');
    const receipt = repo.getReceipt(approval.id);
    expect(receipt?.status).toBe('unknown');
    expect(receiptDisposition(stored?.receipt_status ?? null)).toBe(
      'unconfirmed',
    );
  });
});
