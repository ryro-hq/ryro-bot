import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { loadSettings } from './app/config/service.ts';
import { BotError } from './kernel/errors.ts';
import { databaseLayer } from './adapters/postgres/client.ts';
import { service } from './app/bootstrap.ts';

NodeRuntime.runMain(
  Effect.gen(function* () {
    const settings = yield* Effect.try({
      try: () => loadSettings(),
      catch: () => new BotError({ code: 'invalid-startup-configuration' }),
    });
    yield* service(settings).pipe(
      Effect.provide(
        databaseLayer(
          settings.databaseUrl,
          settings.databaseCa,
          settings.localDatabase,
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
