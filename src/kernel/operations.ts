import { Effect } from 'effect';
import { BotError } from './errors.js';
export class DeferredError extends BotError {
  constructor(
    readonly retryAt: number,
    code = 'github-rate-limited',
  ) {
    super({ code });
  }
}
export const remote = <A>(work: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) =>
      error instanceof BotError
        ? error
        : new BotError({ code: 'remote-operation-failed' }),
  });
