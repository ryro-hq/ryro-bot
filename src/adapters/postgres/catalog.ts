import { PgClient } from '@effect/sql-pg';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import { requireThat } from '../../kernel/errors.ts';
import { CatalogStore } from '../../modules/catalog/contracts.ts';
import type {
  BatchRecord,
  ReleaseRow,
} from '../../modules/catalog/contracts.ts';
import type { Prepared } from '../../modules/catalog/evidence.ts';

export const catalogStoreLayer = Layer.effect(
  CatalogStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      pg = yield* PgClient.PgClient;
    return CatalogStore.of({
      releases: (repository) =>
        Effect.map(
          sql<ReleaseRow>`SELECT package,version,state,security_fix FROM releases WHERE repository=${repository} ORDER BY package,version LIMIT 100001`,
          (rows) => {
            requireThat(
              rows.length <= 100000,
              'inventory-planning-limit-partition-required',
            );
            return rows;
          },
        ),
      batches: (repository) =>
        Effect.map(
          sql<BatchRecord>`SELECT batch_id,intent,run_id::text AS run_id,prepared_sha,branch,evidence_digest,status FROM batches WHERE repository=${repository} ORDER BY updated_at,batch_id LIMIT 10001`,
          (rows) => {
            requireThat(rows.length <= 10000, 'batch-snapshot-incomplete');
            return rows;
          },
        ),
      plan: (batch) =>
        Effect.asVoid(
          sql`INSERT INTO batches (batch_id,repository,base_sha,policy_revision,intent) VALUES (${batch.id},${batch.repository},${batch.baseSha},${batch.policyRevision},${pg.json(batch)}) ON CONFLICT (batch_id) DO UPDATE SET base_sha=EXCLUDED.base_sha,policy_revision=EXCLUDED.policy_revision,intent=EXCLUDED.intent WHERE batches.prepared_sha IS NULL AND batches.run_id IS NULL AND batches.status='planned'`,
        ),
      replan: (batch) =>
        Effect.asVoid(
          sql`UPDATE batches SET base_sha=${batch.baseSha},policy_revision=${batch.policyRevision},intent=${pg.json(batch)},run_id=NULL,evidence_digest=NULL,status='planned',updated_at=clock_timestamp() WHERE batch_id=${batch.id} AND prepared_sha IS NULL`,
        ),
      dispatched: (batch, key, runId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE batches SET run_id=${runId},status='preparing' WHERE batch_id=${batch}`;
            yield* sql`UPDATE operations SET state='complete',receipt=${pg.json({ workflow_run_id: runId })},updated_at=clock_timestamp() WHERE operation_key=${key}`;
          }),
        ),
      status: (batch, status) =>
        Effect.asVoid(
          sql`UPDATE batches SET status=${status},updated_at=clock_timestamp() WHERE batch_id=${batch}`,
        ),
      prepared: (batch, digest) =>
        Effect.asVoid(
          sql`UPDATE batches SET evidence_digest=${digest},status='prepared' WHERE batch_id=${batch}`,
        ),
      commit: (batch, sha, branch) =>
        Effect.asVoid(
          sql`UPDATE batches SET prepared_sha=${sha},branch=${branch} WHERE batch_id=${batch}`,
        ),
      evidence: (digest) =>
        Effect.map(
          sql<{
            document: Prepared;
          }>`SELECT document FROM evidence WHERE digest=${digest}`,
          (rows) => rows[0]?.document ?? null,
        ),
    });
  }),
);
