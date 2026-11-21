import type { PoolClient } from 'pg';
import type { AuditOutcome } from './types.js';

export interface AuditRow {
  actorId: string | null;
  actorRole: 'patient' | 'clinician' | 'admin' | 'engine';
  ipHash: string | null;
  operation: 'READ' | 'WRITE';
  action: string;
  resourceType: string;
  resourceId: string | null;
  subjectId: string | null;
  requestId: string | null;
  outcome: AuditOutcome;
}

/**
 * Append audit rows on the caller's client, so they commit or roll back with
 * the PHI operation itself: an operation that cannot be audited does not happen.
 */
export async function insertAuditRows(client: PoolClient, rows: AuditRow[]): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO audit.audit_logs
       (actor_id, actor_role, ip_hash, operation, action, resource_type, resource_id, subject_id, request_id, outcome)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])`,
    [
      rows.map((r) => r.actorId),
      rows.map((r) => r.actorRole),
      rows.map((r) => r.ipHash),
      rows.map((r) => r.operation),
      rows.map((r) => r.action),
      rows.map((r) => r.resourceType),
      rows.map((r) => r.resourceId),
      rows.map((r) => r.subjectId),
      rows.map((r) => r.requestId),
      rows.map((r) => r.outcome),
    ],
  );
}
