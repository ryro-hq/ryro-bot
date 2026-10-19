import { randomUUID } from 'node:crypto';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import { BotError, requireThat } from '../../kernel/errors.js';
import { sha256 } from '../../kernel/values.js';
import { DiscoveryStore } from '../../modules/catalog/contracts.js';

export const discoveryStoreLayer = Layer.effect(
  DiscoveryStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return DiscoveryStore.of({
      start: (repository, pkg, digest, url) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO channels (repository,package,policy_digest,generation,cursor) VALUES (${repository},${pkg},${digest},${randomUUID()},${url}) ON CONFLICT DO NOTHING`;
          const [old] = yield* sql<{
            policy_digest: string;
            complete: boolean;
          }>`SELECT policy_digest,complete FROM channels WHERE repository=${repository} AND package=${pkg}`;
          requireThat(
            old.policy_digest === digest,
            'discovery-authority-changed-review-required',
          );
          if (old.complete)
            yield* sql`UPDATE channels SET complete=FALSE,cursor=${url},generation=${randomUUID()} WHERE repository=${repository} AND package=${pkg}`;
        }),
      cursor: (repository, pkg) =>
        Effect.map(
          sql<{
            cursor: string;
            generation: string;
          }>`SELECT cursor,generation FROM channels WHERE repository=${repository} AND package=${pkg}`,
          (rows) => rows[0],
        ),
      commit: (repository, pkg, state, body, versions, next) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const [locked] = yield* sql<{
              cursor: string;
              generation: string;
            }>`SELECT cursor,generation FROM channels WHERE repository=${repository} AND package=${pkg} FOR UPDATE`;
            if (
              locked.cursor !== state.cursor ||
              locked.generation !== state.generation
            )
              return yield* new BotError({ code: 'discovery-cursor-race' });
            if (next) {
              const seen =
                yield* sql`SELECT 1 FROM discovery_pages WHERE repository=${repository} AND package=${pkg} AND generation=${state.generation} AND url=${next}`;
              if (next === state.cursor || seen.length)
                return yield* new BotError({ code: 'pagination-cycle' });
            }
            for (const row of versions) {
              const [old] = yield* sql<{
                classification: string;
                origin_ref: string;
              }>`SELECT classification,origin_ref FROM releases WHERE repository=${repository} AND package=${pkg} AND version=${row.version}`;
              if (
                old &&
                (old.classification !== row.classification ||
                  old.origin_ref !== row.originRef)
              )
                return yield* new BotError({
                  code: 'conflicting-release-observation',
                });
              yield* sql`INSERT INTO releases (repository,package,version,classification,origin_ref) VALUES (${repository},${pkg},${row.version},${row.classification},${row.originRef}) ON CONFLICT DO NOTHING`;
            }
            yield* sql`INSERT INTO discovery_pages (repository,package,generation,url,digest,body) VALUES (${repository},${pkg},${state.generation},${state.cursor},${sha256(body)},decode(${body.toString('hex')},'hex'))`;
            yield* sql`UPDATE channels SET cursor=${next},complete=${next === null},last_error=NULL,assessed_at=clock_timestamp() WHERE repository=${repository} AND package=${pkg}`;
          }),
        ),
      failed: (repository, pkg) =>
        Effect.asVoid(
          sql`UPDATE channels SET complete=FALSE,last_error='discovery-failed' WHERE repository=${repository} AND package=${pkg}`,
        ),
      due: (repository, pkg, now) =>
        Effect.map(
          sql<{
            complete: boolean;
            assessed_at: Date | null;
          }>`SELECT complete,assessed_at FROM channels WHERE repository=${repository} AND package=${pkg}`,
          (rows) =>
            !rows[0]?.complete ||
            !rows[0].assessed_at ||
            now - new Date(rows[0].assessed_at).getTime() >= 86400000,
        ),
    });
  }),
);
