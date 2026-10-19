import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { loadSettings } from './app/config/service.js';
import { BotError } from './kernel/errors.js';
import { databaseLayer } from './adapters/postgres/client.js';
import { service } from './app/bootstrap.js';

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
