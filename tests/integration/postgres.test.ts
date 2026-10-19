import { randomUUID } from 'node:crypto';
import { PgClient } from '@effect/sql-pg';
import { NodeServices } from '@effect/platform-node';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { SqlClient } from 'effect/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claim,
  enqueue,
  finish,
  reap,
  receive,
  renew,
} from '../../src/adapters/postgres/jobs.js';
import { databaseLayer } from '../../src/adapters/postgres/client.js';
import { migrate } from '../../src/adapters/postgres/migrations.js';
import { saveEvidence } from '../../src/adapters/postgres/audit.js';
import { discoveryStoreLayer } from '../../src/adapters/postgres/discovery.js';
import { pageFetcherLayer } from '../../src/adapters/http/client.js';
import {
  DiscoveryStore,
  PageFetcher,
} from '../../src/modules/catalog/contracts.js';
import { discover } from '../../src/modules/catalog/discovery.js';
import type { Channel } from '../../src/modules/contracts/project.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('real PostgreSQL durability and recovery', () => {
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.merge(discoveryStoreLayer, pageFetcherLayer),
      Layer.merge(
        databaseLayer(
          url ?? 'postgres://postgres:test@127.0.0.1/test',
          undefined,
          true,
        ),
        NodeServices.layer,
      ),
    ),
  );
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      SqlClient.SqlClient | PgClient.PgClient | DiscoveryStore | PageFetcher
    >,
  ) => runtime.runPromise(effect);
  beforeAll(async () => {
    await runtime.runPromise(migrate);
  });
  afterAll(async () => {
    await runtime.dispose();
  });
  const repo = () => 'test/' + randomUUID();
  it('persists deliveries and exactly one job atomically, even concurrently', async () => {
    const r = repo(),
      id = randomUUID(),
      body = Buffer.from('{"value":1}');
    expect(
      (
        await Promise.all(
          Array.from({ length: 8 }, () => run(receive(id, r, 'push', body))),
        )
      ).filter(Boolean),
    ).toHaveLength(1);
    const counts = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM jobs WHERE repository=${r}`;
      }),
    );
    expect(counts[0].count).toBe(1);
    await expect(
      run(receive(id, r, 'push', Buffer.from('{"value":2}'))),
    ).rejects.toThrow();
  });
  it('rolls back a delivery if job persistence fails', async () => {
    const r = repo(),
      id = randomUUID();
    await expect(
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* receive(id, r, 'push', Buffer.from('{}'));
              yield* Effect.fail(new Error('crash'));
            }),
          );
        }),
      ),
    ).rejects.toThrow();
    expect(await run(receive(id, r, 'push', Buffer.from('{}')))).toBe(true);
  });
  it('serializes workers by repository and fences stale leases', async () => {
    const r = repo();
    await run(enqueue(r, 'test', randomUUID(), {}));
    await run(enqueue(r, 'test', randomUUID(), {}));
    // Other tests leave jobs: fence those out of the claim window without deleting state.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE jobs SET available_at=clock_timestamp()+interval '1 day' WHERE repository<>${r}`;
      }),
    );
    const results = await Promise.all([run(claim), run(claim)]);
    const claimed = results.filter((j) => j !== null);
    expect(claimed).toHaveLength(1);
    const first = claimed[0]!;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${first.id}`;
        yield* sql`UPDATE repositories SET lease_until=clock_timestamp()-interval '1 second' WHERE repository=${r}`;
      }),
    );
    const reclaimed = await run(claim);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.lease_token).not.toBe(first.lease_token);
    await expect(run(renew(first))).rejects.toThrow();
    await run(finish(first));
    await run(renew(reclaimed!));
    await run(finish(reclaimed!));
    const next = await run(claim);
    expect(next).not.toBeNull();
    await run(finish(next!));
  });
  it('limits retries and reaps a worker that crashed on its last attempt', async () => {
    const r = repo();
    await run(enqueue(r, 'test', randomUUID(), {}));
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE jobs SET available_at=clock_timestamp()+interval '1 day' WHERE repository<>${r}`;
        yield* sql`UPDATE jobs SET max_attempts=1 WHERE repository=${r}`;
      }),
    );
    const job = await run(claim);
    expect(job).not.toBeNull();
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${job!.id}`;
      }),
    );
    await run(reap);
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          state: string;
        }>`SELECT state FROM jobs WHERE id=${job!.id}`;
      }),
    );
    expect(rows[0].state).toBe('dead');
  });
  const channel: Channel = {
    url: 'https://example.org/releases/',
    origin: 'https://example.org/',
    format: 'html',
    prefix: 'pkg-',
    suffix: '.tar.gz',
    classification: 'numeric',
  };
  const page = (html: string) => ({
    body: Buffer.from(html),
    headers: new Headers(),
  });
  it('resumes interrupted pagination, retains prereleases and starts a fresh refresh', async () => {
    const r = repo();
    const fetcher = async (url: string) =>
      url.includes('page=2')
        ? page('<a href="pkg-2.0.0-rc1.tar.gz">pre</a>')
        : page(
            '<a href="pkg-1.0.0.tar.gz">old</a><a rel="next" href="?page=2">next</a>',
          );
    expect(await run(discover(r, 'pkg', channel, 1, fetcher))).toEqual({
      complete: false,
      pages: 1,
    });
    expect(await run(discover(r, 'pkg', channel, 1, fetcher))).toEqual({
      complete: true,
      pages: 1,
    });
    expect(await run(discover(r, 'pkg', channel, 2, fetcher))).toEqual({
      complete: true,
      pages: 2,
    });
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT * FROM releases WHERE repository=${r}`;
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.classification === 'prerelease')).toBe(true);
  });
  it('fails closed on pagination cycles and authority changes', async () => {
    const r = repo();
    await expect(
      run(
        discover(r, 'pkg', channel, 1, async () =>
          page('<a rel="next" href="/releases/">next</a>'),
        ),
      ),
    ).rejects.toThrow();
    await expect(
      run(
        discover(
          r,
          'pkg',
          {
            ...channel,
            origin: 'https://other.example/',
            url: 'https://other.example/',
          },
          1,
          async () => page('<html></html>'),
        ),
      ),
    ).rejects.toThrow();
    const state = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          complete: boolean;
        }>`SELECT complete FROM channels WHERE repository=${r}`;
      }),
    );
    expect(state[0].complete).toBe(false);
  });
  it('persists evidence outside product repositories with a content address', async () => {
    const r = repo(),
      doc = { head: 'a'.repeat(40), result: 'passed' };
    const digest = await run(saveEvidence(r, doc, { runId: 7 }));
    expect(await run(saveEvidence(r, doc, { runId: 7 }))).toBe(digest);
    const state = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          document: unknown;
        }>`SELECT document FROM evidence WHERE digest=${digest}`;
      }),
    );
    expect(state[0].document).toEqual(doc);
  });
});
