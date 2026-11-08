import { describe, expect, test } from 'vitest';
import {
  collectFindings,
  deriveAnomalyLedger,
  deriveTelemetryFeatures,
  summarizeSeries,
} from '../../src/diagnosis/analysis.js';
import type { Evidence } from '../../src/diagnosis/contracts/domain.js';

function series(
  id: string,
  metric: string,
  values: number[],
  quality: string[] = [],
): Evidence {
  return {
    id,
    workspace_id: 'ws',
    run_id: 'run',
    source_id: 'src-scada',
    source_kind: 'scada',
    data_mode: 'mock',
    equipment_id: 'EQ-1',
    observed_at: '2026-11-07T00:00:00.000Z',
    fetched_at: '2026-11-07T00:00:00.000Z',
    source_record_id: `${metric}:${id}`,
    payload_hash: 'a'.repeat(64),
    query_hash: 'b'.repeat(64),
    locator: { kind: 'db', ref: id },
    quality_flags: ['good'],
    payload: {
      kind: 'telemetry_series',
      equipment_id: 'EQ-1',
      metric,
      unit: metric === 'bearing_temperature' ? '°C' : 'mm/s',
      points: values.map((value, index) => ({
        t: `2026-11-07T00:${String(index).padStart(2, '0')}:00.000Z`,
        v: value,
        q: quality[index] ?? 'good',
      })),
      stats: {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((sum, value) => sum + value, 0) / values.length,
        count: values.length,
        // 与 MCP store 的 stats.missing 保持一致：只统计 missing 质量点。
        missing: quality.filter((item) => item === 'missing').length,
      },
    },
  };
}

describe('telemetry feature derivation', () => {
  test('flags a constant reading far outside the model normal range', () => {
    const [feature] = deriveTelemetryFeatures(
      [series('ev_range', 'bearing_temperature', Array(10).fill(250))],
      'NP-200',
    );
    expect(feature.flags).toContain('constant');
    expect(feature.flags).toContain('out_of_range');
    expect(feature.flags).toContain('range_limit');
    expect(feature.unique).toBe(1);
    expect(feature.summary).toContain('正常范围 40–80');
    expect(feature.summary).toContain('恒定在量程/物理边界');
  });

  test('uses the equipment-model limit instead of a universal threshold', () => {
    const values = [60, 62, 64, 66, 68, 70, 72, 74, 76, 82];
    const np200 = deriveTelemetryFeatures(
      [series('ev_t', 'bearing_temperature', values)],
      'NP-200',
    )[0];
    const np300 = deriveTelemetryFeatures(
      [series('ev_t', 'bearing_temperature', values)],
      'NP-300',
    )[0];
    expect(np200.flags).toContain('out_of_range');
    expect(np200.flags).toContain('trend');
    expect(np300.flags).not.toContain('out_of_range');
    expect(np300.flags).toContain('trend');
  });

  test('counts only missing quality as missing, not clock skew', () => {
    const quality = Array(10).fill('good') as string[];
    quality[2] = 'clock_skew';
    quality[5] = 'clock_skew';
    const evidence = series(
      'ev_clock',
      'bearing_temperature',
      Array(10).fill(65),
      quality,
    );
    const summary = summarizeSeries(evidence)!;
    const [feature] = deriveTelemetryFeatures([evidence], 'NP-200');
    expect(summary.missing).toBe(0);
    expect(feature.missing).toBe(0);
    expect(feature.flags).toContain('clock_skew');
    expect(feature.flags).not.toContain('missing');
    expect(feature.summary).toContain('缺失 0');
  });

  test('counts missing quality points separately from other quality flags', () => {
    const quality = Array(10).fill('good') as string[];
    quality[1] = 'missing';
    quality[4] = 'missing';
    quality[7] = 'clock_skew';
    const evidence = series(
      'ev_missing',
      'bearing_temperature',
      Array(10).fill(65),
      quality,
    );
    const summary = summarizeSeries(evidence)!;
    const [feature] = deriveTelemetryFeatures([evidence], 'NP-200');
    expect(summary.missing).toBe(2);
    expect(feature.missing).toBe(2);
    expect(feature.flags).toContain('missing');
    expect(feature.flags).toContain('clock_skew');
    expect(feature.summary).toContain('缺失 2');
  });

  test('excludes missing sample values from numeric telemetry features', () => {
    const values = Array(10).fill(65);
    const quality = Array(10).fill('good') as string[];
    // 缺失点携带陈旧/占位数值，不能污染 min/max/avg、趋势和尖峰判断。
    values[9] = 250;
    quality[9] = 'missing';
    const evidence = series(
      'ev_missing_value',
      'bearing_temperature',
      values,
      quality,
    );
    const summary = summarizeSeries(evidence)!;
    const [feature] = deriveTelemetryFeatures([evidence], 'NP-200');
    expect(summary.missing).toBe(1);
    expect(summary.min).toBe(65);
    expect(summary.max).toBe(65);
    expect(summary.avg).toBe(65);
    expect(summary.delta).toBe(0);
    expect(summary.spikeCount).toBe(0);
    expect(feature.flags).toContain('missing');
    expect(feature.flags).not.toContain('out_of_range');
    expect(feature.flags).not.toContain('spike');
    expect(feature.flags).not.toContain('near_upper_limit');
    expect(feature.summary).toContain('min 65 / max 65 / avg 65');
  });

  test('keeps an entirely missing series visible as a missing anomaly', () => {
    const missing = series(
      'ev_all_missing',
      'bearing_temperature',
      Array(10).fill(250),
      Array(10).fill('missing'),
    );
    const normal = series(
      'ev_normal_vibration',
      'vibration_rms',
      Array(10).fill(3),
    );
    const summary = summarizeSeries(missing)!;
    expect(summary.valid).toBe(0);
    expect(summary.missing).toBe(10);

    const features = deriveTelemetryFeatures([missing, normal], 'NP-200');
    const temperature = features.find(
      (feature) => feature.metric === 'bearing_temperature',
    )!;
    expect(temperature.missing).toBe(10);
    expect(temperature.flags).toContain('missing');
    expect(temperature.flags).not.toContain('out_of_range');
    expect(temperature.flags).not.toContain('spike');
    expect(temperature.flags).not.toContain('constant');
    expect(temperature.summary).toContain('无数值样本');

    const findings = collectFindings({
      evidence: [missing, normal],
      equipment: {
        equipment_id: 'EQ-1',
        name: 'Test',
        vendor: 'V',
        model: 'NP-200',
        serial: 'S',
        manual_document_id: 'DOC-1',
        manual_version: 'v1',
        source_ids: ['src-scada'],
      },
      alarm: null,
      toolHistory: [],
    });
    expect(findings.missingSamples).toBe(10);
    // 另一条正常序列不能让完全不可用的通道被算作“指标正常”。
    expect(findings.allMetricsNormal).toBe(false);
  });

  test('separates support, contradiction and unexplained references', () => {
    const features = deriveTelemetryFeatures(
      [
        series('ev_vib', 'vibration_rms', [2, 2.4, 3, 3.8, 4.6, 5.4]),
        series('ev_temp', 'bearing_temperature', [65, 66, 67, 68, 69, 70]),
      ],
      'NP-200',
    );
    const ledger = deriveAnomalyLedger(features, [
      {
        code: 'bearing_wear',
        status: 'supported',
        supporting_evidence_ids: ['ev_vib'],
        contradicting_evidence_ids: ['ev_temp'],
      },
    ]);
    const vibration = ledger.find((item) => item.evidenceId === 'ev_vib')!;
    const temperature = ledger.find((item) => item.evidenceId === 'ev_temp')!;
    expect(vibration.unexplained).toBe(false);
    expect(vibration.referencedAsSupport).toEqual(['bearing_wear']);
    expect(temperature.unexplained).toBe(true);
    expect(temperature.referencedAsContradiction).toEqual(['bearing_wear']);
  });
});
