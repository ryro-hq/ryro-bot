import { Cause, Effect } from 'effect';
import { BotError } from './errors.js';
import { DeferredError } from './operations.js';
import type { ModuleRegistry } from './modules.js';
import { claim, finish, renew } from './jobs.js';
export const workOnce = <R>(
  registry: ModuleRegistry<R>,
  heartbeatMilliseconds = 30000,
) =>
  Effect.gen(function* () {
    const job = yield* claim;
    if (!job) return false;
    const operation = Effect.gen(function* () {
      const definition = registry.handlers.get(job.kind);
      if (!definition) return yield* new BotError({ code: 'unknown-job-kind' });
      if ((job.payload_version ?? 1) !== definition.payloadVersion)
        return yield* new BotError({ code: 'unsupported-job-payload-version' });
      yield* Effect.try({
        try: () => definition.validate(job.payload),
        catch: () => new BotError({ code: 'invalid-job-payload' }),
      });
      yield* definition.run(job);
    }).pipe(Effect.scoped);
    const heartbeat = Effect.sleep(heartbeatMilliseconds).pipe(
      Effect.andThen(renew(job)),
      Effect.forever,
    );
    yield* Effect.raceFirst(operation, heartbeat).pipe(
      Effect.andThen(finish(job)),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
          const error = Cause.squash(cause);
          const code =
            error instanceof BotError ? error.code : 'operation-failed';
          if (code !== 'lost-lease')
            yield* finish(
              job,
              code,
              error instanceof DeferredError ? error.retryAt : undefined,
              [
                'unknown-job-kind',
                'unsupported-job-payload-version',
                'invalid-job-payload',
              ].includes(code),
            );
          yield* Effect.logWarning('Job did not complete', {
            jobId: job.id,
            repository: job.repository,
            kind: job.kind,
            code,
          });
        }),
      ),
    );
    return true;
  });
