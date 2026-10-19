import type { Effect, Scope } from 'effect';
import type { Job } from './jobs.ts';
import type { JobIntent } from './persistence.ts';
export interface JobDefinition<R> {
  kind: string;
  payloadVersion: number;
  validate(payload: unknown): unknown;
  run(job: Job): Effect.Effect<unknown, unknown, R | Scope.Scope>;
}
export interface BotModule<R = never> {
  id: string;
  requires?: readonly string[];
  jobs: readonly JobDefinition<R>[];
  webhook?(
    repository: string,
    event: string,
    payload: unknown,
  ): readonly JobIntent[];
  schedule?(now: number): Effect.Effect<unknown, unknown, R>;
}
