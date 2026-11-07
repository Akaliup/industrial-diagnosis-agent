import { describe, expect, test } from 'vitest';
import { RepeatGuard } from '../../src/diagnosis/repeat-guard.js';
import type { ToolResponseEnvelope } from '../../src/diagnosis/contracts/domain.js';

function envelope(): ToolResponseEnvelope {
  return {
    schema_version: '1',
    request_id: 'req_repeat',
    logical_call_id: 'lc_repeat',
    data_mode: 'mock',
    status: 'success',
    data: { ok: true },
    evidence: [],
    coverage: {
      from: '2026-11-07T00:00:00.000Z',
      to: '2026-11-07T00:30:00.000Z',
      complete: true,
      missing: [],
    },
    warnings: [],
    error: null,
    next_cursor: null,
  };
}

describe('repeat guard', () => {
  test('rejects consecutive identical calls and explains why', () => {
    const guard = new RepeatGuard();
    const key = guard.key('equipment_query', { a: 1 }, 'ws|run|eq', 'base');
    expect(guard.check(key).action).toBe('execute');
    guard.record(key, envelope());
    const repeated = guard.check(key);
    expect(repeated.action).toBe('rejected');
    expect(repeated.message).toContain('已有证据');
  });

  test('reuses a cached success when other queries intervene', () => {
    const guard = new RepeatGuard();
    const key = guard.key('equipment_query', { a: 1 }, 'ws|run|eq', 'base');
    const other = guard.key('equipment_query', { a: 2 }, 'ws|run|eq', 'base');
    expect(guard.check(key).action).toBe('execute');
    guard.record(key, envelope());
    expect(guard.check(other).action).toBe('execute');
    const cached = guard.check(key);
    expect(cached.action).toBe('cached');
    expect(cached.cached?.status).toBe('success');
  });

  test('never caches failed envelopes', () => {
    const guard = new RepeatGuard();
    const key = guard.key('equipment_query', { a: 1 }, 'ws|run|eq', 'base');
    const other = guard.key('equipment_query', { a: 2 }, 'ws|run|eq', 'base');
    guard.check(key);
    guard.record(key, {
      ...envelope(),
      status: 'error',
      error: {
        code: 'SOURCE_UNAVAILABLE',
        retryable: true,
        safe_message: 'down',
      },
    });
    // 插入不同查询，避免连续重复规则先于缓存检查生效。
    guard.check(other);
    expect(guard.check(key).action).toBe('execute');
  });

  test('key changes with scope and source snapshot', () => {
    const guard = new RepeatGuard();
    const args = { equipment_id: 'EQ-DEMO-001', query_kind: 'status' };
    const base = guard.key('equipment_query', args, 'ws|run|eq', 'base');
    expect(guard.key('equipment_query', args, 'ws|run|eq', 'v2')).not.toBe(
      base,
    );
    expect(guard.key('equipment_query', args, 'ws|run2|eq', 'base')).not.toBe(
      base,
    );
  });
});
