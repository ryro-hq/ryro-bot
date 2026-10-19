import { Effect } from 'effect';
import { BotError } from './errors.ts';
export class DeferredError extends BotError {
  readonly retryAt: number;
  constructor(retryAt: number, code = 'github-rate-limited') {
    super({ code });
    this.retryAt = retryAt;
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
