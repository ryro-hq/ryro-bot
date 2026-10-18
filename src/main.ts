import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { loadSettings } from './config.js';
import { BotError } from './domain.js';
import { databaseLayer } from './db.js';
import { service } from './service.js';

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
