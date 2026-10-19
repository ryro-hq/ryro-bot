import { Effect, Fiber, Redacted } from 'effect';
import { SqlClient } from 'effect/sql';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { postgresTest } from '../support/postgres.js';
import { service } from '../../src/app/bootstrap.js';
import { migrate } from '../../src/adapters/postgres/migrations.js';
import { decodeProjects } from '../../src/app/config/registry.js';
import { base, revision } from '../support/projects.js';
import type { Settings } from '../../src/app/config/service.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('service lifecycle', () => {
  const db = postgresTest(),
    run = db.runtime.runPromise;
  beforeAll(db.create);
  afterAll(db.dispose);
  const settings: Settings = {
    mode: 'observe',
    revision,
    version: base,
    projects: decodeProjects({
      schema: 2,
      projects: [
        {
          repository: 'owner/lifecycle',
          policy: 'ci-v1',
          fallback: ['@maintainer'],
          modules: ['ci'],
        },
      ],
    }),
    bindings: {},
    schedulerSeconds: 300,
    host: '127.0.0.1',
    port: 0,
    webhookSecret: Redacted.make('s'.repeat(32)),
    databaseUrl: 'unused',
    localDatabase: true,
  };
  it('refuses an unmigrated database before HTTP or workers start', async () => {
    await expect(run(service(settings))).rejects.toThrow(
      'database-schema-pending',
    );
  });
  it('interrupts scheduler and workers and closes resources promptly', async () => {
    await run(migrate);
    const fiber = db.runtime.runFork(service(settings));
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT id FROM jobs WHERE repository='owner/lifecycle'`;
        }),
      );
      if (rows.length) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(started).toBe(true);
    await run(Fiber.interrupt(fiber).pipe(Effect.timeout('2 seconds')));
  });
});
