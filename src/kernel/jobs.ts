import { Effect } from 'effect';
import { JobStore } from './contracts/persistence.ts';
import type { JobIntent } from './contracts/persistence.ts';
import type { Job } from './contracts/jobs.ts';
export const enqueue = (
  repository: string,
  kind: string,
  key: string,
  payload: unknown,
) => Effect.flatMap(JobStore, (s) => s.enqueue(repository, kind, key, payload));
export const request = (repository: string, intent: JobIntent) =>
  Effect.flatMap(JobStore, (s) => s.request(repository, intent));
export const claim = Effect.flatMap(JobStore, (s) => s.claim);
export const renew = (job: Job) =>
  Effect.flatMap(JobStore, (s) => s.renew(job));
export const finish = (
  job: Job,
  error?: string,
  retryAt?: number,
  terminal?: boolean,
) => Effect.flatMap(JobStore, (s) => s.finish(job, error, retryAt, terminal));
export const reap = Effect.flatMap(JobStore, (s) => s.reap);

export const receive = (
  delivery: string,
  repository: string,
  event: string,
  body: Buffer,
  intents?: readonly JobIntent[],
) =>
  Effect.flatMap(JobStore, (s) =>
    s.receive(delivery, repository, event, body, intents),
  );
