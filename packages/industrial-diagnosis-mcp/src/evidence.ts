import crypto from 'node:crypto';
import type {
  DataMode,
  EvidenceDraft,
  EvidenceLocator,
  EvidencePayload,
  QualityFlag,
  SourceKind,
} from './contracts/domain.js';

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export interface EvidenceContext {
  workspaceId: string;
  runId: string;
  dataMode: DataMode;
  query: unknown;
}

export interface EvidenceInput {
  sourceId: string;
  sourceKind: SourceKind;
  equipmentId: string | null;
  observedAt: string | null;
  sourceRecordId: string;
  locator: EvidenceLocator;
  qualityFlags?: QualityFlag[];
  payload: EvidencePayload;
}

export function buildEvidence(
  ctx: EvidenceContext,
  input: EvidenceInput,
): EvidenceDraft {
  const payloadHash = sha256(canonicalJson(input.payload));
  const queryHash = sha256(canonicalJson(ctx.query));
  const id = `ev_${sha256(
    `${ctx.workspaceId}|${ctx.runId}|${input.sourceId}|${input.sourceRecordId}|${payloadHash}`,
  ).slice(0, 20)}`;
  return {
    id,
    workspace_id: ctx.workspaceId,
    run_id: ctx.runId,
    source_id: input.sourceId,
    source_kind: input.sourceKind,
    data_mode: ctx.dataMode,
    equipment_id: input.equipmentId,
    observed_at: input.observedAt,
    fetched_at: new Date().toISOString(),
    source_record_id: input.sourceRecordId,
    payload_hash: payloadHash,
    query_hash: queryHash,
    locator: input.locator,
    quality_flags: input.qualityFlags ?? [],
    payload: input.payload,
  };
}
