import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Console } from 'effect';
import { loadDatabaseSettings } from './app/config/database.js';
import { databaseLayer } from './adapters/postgres/client.js';
import {
  migrate,
  migrationStatus,
  checkMigrations,
} from './adapters/postgres/migrations.js';
import { requireThat } from './kernel/errors.js';

export const migrationProgram = (args: string[], env = process.env) =>
  Effect.gen(function* () {
    const command = args[0] ?? 'apply';
    if (command === '--help' || command === 'help') {
      yield* Console.log(
        'migrate [apply|status|check] — requires only database configuration',
      );
      return;
    }
    requireThat(
      args.length <= 1 && ['apply', 'status', 'check'].includes(command),
      'usage-migrate-apply-status-check',
    );
    const settings = yield* Effect.sync(() => loadDatabaseSettings(env));
    yield* Effect.gen(function* () {
      if (command === 'apply') yield* migrate;
      if (command === 'check') yield* checkMigrations;
      yield* Console.log(JSON.stringify(yield* migrationStatus));
    }).pipe(
      Effect.provide(
        databaseLayer(
          settings.databaseUrl,
          settings.databaseCa,
          settings.localDatabase,
        ),
      ),
    );
  });
NodeRuntime.runMain(
  migrationProgram(process.argv.slice(2)).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
