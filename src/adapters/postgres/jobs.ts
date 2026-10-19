import { randomUUID } from 'node:crypto';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer } from 'effect';
import { JobStore } from '../../kernel/contracts/persistence.js';
import type { JobIntent } from '../../kernel/contracts/persistence.js';
import { SqlClient } from 'effect/sql';
import { BotError, requireThat } from '../../kernel/errors.js';
import { sha256 } from '../../kernel/values.js';
import type { Job } from '../../kernel/contracts/jobs.js';
export const enqueue = (
  repository: string,
  kind: string,
  key: string,
  payload: unknown,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    yield* sql`INSERT INTO repositories (repository) VALUES (${repository}) ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO jobs (id,repository,kind,dedup_key,payload) VALUES (${randomUUID()},${repository},${kind},${key},${pg.json(payload)}) ON CONFLICT (dedup_key) DO NOTHING`;
  });

export const receive = (
  delivery: string,
  repository: string,
  event: string,
  body: Buffer,
  intents?: readonly JobIntent[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    const digest = sha256(body),
      payload: unknown = JSON.parse(body.toString('utf8'));
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO repositories (repository) VALUES (${repository}) ON CONFLICT DO NOTHING`;
        const inserted = yield* sql<{
          delivery_id: string;
        }>`INSERT INTO deliveries (delivery_id,repository,event,digest,payload)
      VALUES (${delivery},${repository},${event},${digest},${pg.json(payload)}) ON CONFLICT DO NOTHING RETURNING delivery_id`;
        if (!inserted.length) {
          const rows = yield* sql<{
            digest: string;
            event: string;
            repository: string;
          }>`SELECT digest,event,repository FROM deliveries WHERE delivery_id=${delivery}`;
          if (
            rows[0].digest !== digest ||
            rows[0].event !== event ||
            rows[0].repository !== repository
          )
            return yield* new BotError({ code: 'delivery-id-collision' });
          return false;
        }
        if (intents) {
          for (const intent of intents) yield* request(repository, intent);
        } else
          yield* enqueue(repository, 'reconcile', 'delivery:' + delivery, {
            event,
          });
        return true;
      }),
    );
  });

export const claim = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pg = yield* PgClient.PgClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // A repository row serializes remote operations across workers and scheduler jobs.
      const repos = yield* sql<{
        repository: string;
      }>`SELECT repository FROM repositories r
      WHERE (lease_until IS NULL OR lease_until < clock_timestamp()) AND EXISTS (
        SELECT 1 FROM jobs j WHERE j.repository=r.repository AND j.attempts<j.max_attempts AND j.available_at<=clock_timestamp()
        AND (j.state='pending' OR (j.state='running' AND j.lease_until<clock_timestamp())))
      ORDER BY last_claimed_at NULLS FIRST,repository FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!repos.length) return null;
      const token = randomUUID();
      const jobs =
        yield* sql<Job>`UPDATE jobs SET state='running', attempts=attempts+1,lease_token=${token},lease_until=clock_timestamp()+interval '5 minutes'
      WHERE id=(SELECT id FROM jobs WHERE repository=${repos[0].repository} AND attempts<max_attempts AND available_at<=clock_timestamp()
      AND (state='pending' OR (state='running' AND lease_until<clock_timestamp())) ORDER BY floor(extract(epoch FROM (clock_timestamp()-created_at))/300) DESC,priority,available_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id,repository,kind,payload,lease_token,attempts,generation,payload_version`;
      if (!jobs.length) return null;
      yield* sql`UPDATE repositories SET last_claimed_at=clock_timestamp(),lease_token=${token},lease_until=clock_timestamp()+interval '5 minutes' WHERE repository=${repos[0].repository}`;
      return jobs[0];
    }),
  );
});

export const renew = (job: Job) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE repositories SET lease_until=clock_timestamp()+interval '5 minutes'
      WHERE repository=${job.repository} AND lease_token=${job.lease_token} AND lease_until>clock_timestamp() RETURNING repository`;
        if (!rows.length) return yield* new BotError({ code: 'lost-lease' });
        const jobs =
          yield* sql`UPDATE jobs SET lease_until=clock_timestamp()+interval '5 minutes' WHERE id=${job.id} AND lease_token=${job.lease_token} AND state='running' AND lease_until>clock_timestamp() RETURNING id`;
        if (!jobs.length) return yield* new BotError({ code: 'lost-lease' });
      }),
    );
  });

export const finish = (
  job: Job,
  error?: string,
  retryAt?: number,
  terminal = false,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const owned =
          yield* sql`SELECT repository FROM repositories WHERE repository=${job.repository} AND lease_token=${job.lease_token} AND lease_until>clock_timestamp() FOR UPDATE`;
        if (!owned.length) return;
        yield* sql`UPDATE jobs SET
        state=CASE WHEN ${terminal} THEN 'dead'
          WHEN ${retryAt !== undefined} THEN 'pending'
          WHEN ${error !== undefined} THEN CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'pending' END
          WHEN generation>${job.generation ?? 1} THEN 'pending' ELSE 'done' END,
        attempts=CASE WHEN ${retryAt !== undefined} THEN GREATEST(0,attempts-1) WHEN ${error === undefined} AND generation>${job.generation ?? 1} THEN 0 ELSE attempts END,
        last_error=${error ?? null},
        available_at=CASE WHEN ${retryAt !== undefined} THEN to_timestamp(${(retryAt ?? 0) / 1000}) WHEN ${error !== undefined} THEN clock_timestamp()+make_interval(secs=>LEAST(3600,power(2,attempts)::int)) ELSE clock_timestamp() END,
        lease_until=NULL,lease_token=NULL
        WHERE id=${job.id} AND lease_token=${job.lease_token} AND state='running' AND lease_until>clock_timestamp()`;
        yield* sql`UPDATE repositories SET lease_token=NULL,lease_until=NULL WHERE repository=${job.repository} AND lease_token=${job.lease_token}`;
      }),
    );
  });

export const reap = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pg = yield* PgClient.PgClient;
  yield* sql`UPDATE jobs SET state='dead',last_error='lease-expired-at-attempt-limit' WHERE state='running' AND lease_until<clock_timestamp() AND attempts>=max_attempts`;
});

export const request = (repository: string, intent: JobIntent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      pg = yield* PgClient.PgClient;
    yield* sql`INSERT INTO repositories (repository) VALUES (${repository}) ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO jobs (id,repository,kind,dedup_key,payload,coalesce_key,priority)
    VALUES (${randomUUID()},${repository},${intent.kind},${randomUUID()},${pg.json(intent.payload)},${intent.kind + ':' + (intent.scope ?? 'repository')},${intent.priority ?? 10})
    ON CONFLICT (repository,coalesce_key) WHERE coalesce_key IS NOT NULL AND state IN ('pending','running')
    DO UPDATE SET generation=jobs.generation+1,payload=EXCLUDED.payload`;
  });

export const registerRepository = (
  repository: string,
  id: number | undefined,
  canonical: string,
  aliases: readonly string[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Serialize identity registration without changing historical foreign keys or digests.
        yield* sql`SELECT pg_advisory_xact_lock(824794739101843263::bigint)`;
        const rows = yield* sql<{
          repository: string;
          github_id: string | null;
        }>`SELECT repository,github_id::text AS github_id FROM repositories WHERE github_id=${id ?? null} OR repository IN ${sql.in([repository, ...aliases])} FOR UPDATE`;
        requireThat(
          rows.length <= 1 &&
            (id === undefined ||
              !rows[0]?.github_id ||
              Number(rows[0].github_id) === id),
          'repository-identity-conflict',
        );
        const key = rows[0]?.repository ?? repository;
        yield* sql`INSERT INTO repositories (repository,github_id,canonical_name) VALUES (${key},${id ?? null},${canonical})
      ON CONFLICT(repository) DO UPDATE SET github_id=COALESCE(EXCLUDED.github_id,repositories.github_id),canonical_name=EXCLUDED.canonical_name`;
        return key;
      }),
    );
  });

export const jobStoreLayer = Layer.effect(
  JobStore,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      SqlClient.SqlClient | PgClient.PgClient
    >();
    const bind = <A, E>(
      effect: Effect.Effect<A, E, SqlClient.SqlClient | PgClient.PgClient>,
    ) => effect.pipe(Effect.provide(context));
    const sql = yield* SqlClient.SqlClient;
    return {
      enqueue: (...args: Parameters<typeof enqueue>) => bind(enqueue(...args)),
      request: (...args: Parameters<typeof request>) => bind(request(...args)),
      receive: (...args: Parameters<typeof receive>) => bind(receive(...args)),
      claim: bind(claim),
      renew: (job: Job) => bind(renew(job)),
      finish: (...args: Parameters<typeof finish>) => bind(finish(...args)),
      reap: bind(reap),
      healthy: bind(Effect.asVoid(sql`SELECT 1`)),
      register: (...args: Parameters<typeof registerRepository>) =>
        bind(registerRepository(...args)),
    };
  }),
);
