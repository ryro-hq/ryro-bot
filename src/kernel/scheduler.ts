import { Cause, Effect } from 'effect';
import type { ModuleRegistry } from './modules.ts';
import { reap } from './jobs.ts';
export const schedule = <R>(registry: ModuleRegistry<R>, now = Date.now()) =>
  Effect.gen(function* () {
    yield* reap;
    for (const module of registry.modules)
      if (module.schedule)
        yield* module.schedule(now).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning('Module scheduling failed', {
                  module: module.id,
                }),
          ),
        );
  });
