import { Data } from 'effect';
export class BotError extends Data.TaggedError('BotError')<{
  readonly code: string;
}> {
  override get message() {
    return this.code;
  }
}

export function requireThat(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) throw new BotError({ code });
}
