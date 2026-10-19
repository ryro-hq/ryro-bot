import { Context, Effect } from 'effect';
import type { Job } from './jobs.ts';
import type { AuditContext } from './audit.ts';

export interface JobIntent {
  kind: string;
  payload: unknown;
  scope?: string;
  priority?: number;
}
export class JobStore extends Context.Service<
  JobStore,
  {
    enqueue(
      repository: string,
      kind: string,
      key: string,
      payload: unknown,
    ): Effect.Effect<void, unknown>;
    request(
      repository: string,
      intent: JobIntent,
    ): Effect.Effect<void, unknown>;
    receive(
      delivery: string,
      repository: string,
      event: string,
      body: Buffer,
      intents?: readonly JobIntent[],
    ): Effect.Effect<boolean, unknown>;
    readonly claim: Effect.Effect<Job | null, unknown>;
    renew(job: Job): Effect.Effect<void, unknown>;
    finish(
      job: Job,
      error?: string,
      retryAt?: number,
      terminal?: boolean,
    ): Effect.Effect<void, unknown>;
    readonly reap: Effect.Effect<void, unknown>;
    readonly healthy: Effect.Effect<void, unknown>;
    register(
      repository: string,
      id: number | undefined,
      canonical: string,
      aliases: readonly string[],
    ): Effect.Effect<string, unknown>;
  }
>()('ryro/JobStore') {}

export class AuditStore extends Context.Service<
  AuditStore,
  {
    write(
      operation: string,
      context: AuditContext,
    ): Effect.Effect<void, unknown>;
    evidence(
      repository: string,
      document: unknown,
      source: unknown,
    ): Effect.Effect<string, unknown>;
  }
>()('ryro/AuditStore') {}

export interface Operation {
  repository: string;
  batch_id: string;
  state: string;
  receipt: unknown;
  retry_at: Date | null;
}
export class OperationStore extends Context.Service<
  OperationStore,
  {
    get(key: string): Effect.Effect<Operation | null, unknown>;
    begin(
      repository: string,
      batch: string,
      key: string,
      kind: string,
    ): Effect.Effect<boolean, unknown>;
    complete(key: string, receipt: unknown): Effect.Effect<void, unknown>;
    uncertain(key: string): Effect.Effect<void, unknown>;
    defer(key: string, until: number): Effect.Effect<void, unknown>;
  }
>()('ryro/OperationStore') {}
