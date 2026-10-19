import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { NodeServices } from '@effect/platform-node';
import { afterEach, expect, it } from 'vitest';
import { loadDatabaseSettings } from '../../../src/app/config/database.ts';
import { loadAdminSettings } from '../../../src/app/config/service.ts';
import { adminProgram } from '../../../src/adapters/cli/admin.ts';
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function configuration() {
  const directory = mkdtempSync(join(tmpdir(), 'ryro-config-'));
  temporary.push(directory);
  const write = (name: string, value: string) => {
    const file = join(directory, name);
    writeFileSync(file, value);
    return file;
  };
  const registry = write(
    'registry.json',
    JSON.stringify({
      schema: 2,
      projects: [
        {
          repository: 'owner/app',
          policy: 'ci-v1',
          fallback: ['@maintainer'],
          modules: ['ci'],
        },
      ],
    }),
  );
  return {
    write,
    env: {
      DATABASE_URL_FILE: write('database-url', 'postgres://u@localhost/db'),
      RYRO_LOCAL_DATABASE: 'true',
      RYRO_REGISTRY: registry,
      RYRO_POLICY_REVISION: 'a'.repeat(40),
      RYRO_BOT_VERSION: 'b'.repeat(40),
    },
  };
}
it('loads database configuration independently of App, registry and webhook secrets', () => {
  const { env } = configuration();
  expect(
    loadDatabaseSettings({
      DATABASE_URL_FILE: env.DATABASE_URL_FILE,
      RYRO_LOCAL_DATABASE: 'true',
    }),
  ).toMatchObject({
    databaseUrl: 'postgres://u@localhost/db',
    localDatabase: true,
  });
});
it('defaults to observation and four workers, with bounded concurrency', () => {
  const { env } = configuration();
  expect(loadAdminSettings(env)).toMatchObject({
    mode: 'observe',
    workerConcurrency: 4,
  });
  for (const workers of ['0', '33', '1.5', 'NaN'])
    expect(() => loadAdminSettings({ ...env, RYRO_WORKERS: workers })).toThrow(
      'invalid-scheduler-or-workers',
    );
  expect(() => loadAdminSettings({ ...env, RYRO_MODE: 'publish' })).toThrow(
    'app-required-for-writes',
  );
});
it('rejects multiple bindings for one repository identity', () => {
  const { env, write } = configuration();
  writeFileSync(
    env.RYRO_REGISTRY,
    JSON.stringify({
      schema: 2,
      projects: ['owner/a', 'owner/b'].map((repository) => ({
        repository,
        policy: 'ci-v1',
        fallback: ['@maintainer'],
        modules: ['ci'],
      })),
    }),
  );
  const bindings = write(
    'bindings.json',
    JSON.stringify({
      'owner/a': { repositoryId: 1, installationId: 2 },
      'owner/b': { repositoryId: 1, installationId: 2 },
    }),
  );
  expect(() =>
    loadAdminSettings({ ...env, RYRO_BINDINGS_FILE: bindings }),
  ).toThrow('duplicate-installation-binding');
});
it('shows help without loading credentials and routes with only the registry', async () => {
  await expect(
    Effect.runPromise(
      adminProgram(['--help'], {}).pipe(Effect.provide(NodeServices.layer)),
    ),
  ).resolves.toBeUndefined();
  const { env } = configuration();
  await expect(
    Effect.runPromise(
      adminProgram(['route', 'owner/app', 'maintainer', 'README.md'], {
        RYRO_REGISTRY: env.RYRO_REGISTRY,
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  ).resolves.toBeUndefined();
});
it('rejects review routing without an author before loading database or App credentials', async () => {
  const { env } = configuration();
  await expect(
    Effect.runPromise(
      adminProgram(['route', 'owner/app'], {
        RYRO_REGISTRY: env.RYRO_REGISTRY,
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  ).rejects.toThrow('author-required');
});
