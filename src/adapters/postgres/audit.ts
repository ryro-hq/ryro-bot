import { PgClient } from '@effect/sql-pg';
import { Effect, Layer } from 'effect';
import { AuditStore } from '../../kernel/contracts/persistence.ts';
import { SqlClient } from 'effect/sql';
import { canonical, sha256 } from '../../kernel/values.ts';
import type { AuditContext } from '../../kernel/contracts/audit.ts';
export const audit = (operation: string, context: AuditContext) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    yield* sql`INSERT INTO audit (repository,operation,policy_revision,base_sha,produced_sha,bot_version,evidence)
    VALUES (${context.repository},${operation},${context.policyRevision},${context.baseSha},${context.producedSha},${context.botVersion},${pg.json(context.evidence)})`;
  });

export const saveEvidence = (
  repository: string,
  document: unknown,
  source: unknown,
) =>
  Effect.gen(function* () {
    const pg = yield* PgClient.PgClient;
    const sql = yield* SqlClient.SqlClient,
      digest = sha256(canonical(document));
    yield* sql`INSERT INTO evidence (digest,repository,source,document) VALUES (${digest},${repository},${pg.json(source)},${pg.json(document)}) ON CONFLICT DO NOTHING`;
    return digest;
  });

export const auditStoreLayer = Layer.effect(
  AuditStore,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      SqlClient.SqlClient | PgClient.PgClient
    >();
    return {
      write: (...args: Parameters<typeof audit>) =>
        audit(...args).pipe(Effect.provide(context)),
      evidence: (...args: Parameters<typeof saveEvidence>) =>
        saveEvidence(...args).pipe(Effect.provide(context)),
    };
  }),
);
