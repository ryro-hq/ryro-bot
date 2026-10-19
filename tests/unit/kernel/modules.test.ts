import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { registerModules } from '../../../src/kernel/modules.ts';
import { workOnce } from '../../../src/kernel/worker.ts';
import { JobStore } from '../../../src/kernel/contracts/persistence.ts';
import type { BotModule } from '../../../src/kernel/contracts/modules.ts';
import type { Job } from '../../../src/kernel/contracts/jobs.ts';
import { BotError } from '../../../src/kernel/errors.ts';
import { DeferredError } from '../../../src/kernel/operations.ts';

const job: Job = {
  id: 'job',
  repository: 'owner/repo',
  kind: 'ci.reconcile',
  payload: {},
  lease_token: 'lease',
  attempts: 1,
  generation: 1,
  payload_version: 1,
};
const module = (
  run: () => Effect.Effect<unknown, unknown> = () => Effect.void,
): BotModule => ({
  id: 'ci',
  jobs: [{ kind: job.kind, payloadVersion: 1, validate: (x) => x, run }],
});
function store(overrides: Partial<JobStore['Service']> = {}) {
  const finishes: unknown[][] = [];
  return {
    finishes,
    value: JobStore.of({
      enqueue: () => Effect.void,
      request: () => Effect.void,
      receive: () => Effect.succeed(true),
      claim: Effect.succeed(job),
      renew: () => Effect.void,
      finish: (...args) =>
        Effect.sync(() => {
          finishes.push(args);
        }),
      reap: Effect.void,
      healthy: Effect.void,
      register: (repository) => Effect.succeed(repository),
      ...overrides,
    }),
  };
}
describe('module kernel', () => {
  it('rejects duplicate modules, missing dependencies, cycles and duplicate handlers', () => {
    expect(() => registerModules([module(), module()])).toThrow(
      'duplicate-module',
    );
    expect(() =>
      registerModules([{ ...module(), requires: ['missing'] }]),
    ).toThrow('missing-module-dependency');
    expect(() => registerModules([{ ...module(), requires: ['ci'] }])).toThrow(
      'module-dependency-cycle',
    );
    expect(() =>
      registerModules([module(), { ...module(), id: 'other' }]),
    ).toThrow('duplicate-or-invalid-job');
  });
  it('does not invoke handlers for incompatible persisted payloads', async () => {
    let called = false;
    for (const invalid of [
      { ...job, kind: 'missing' },
      { ...job, payload_version: 2 },
    ]) {
      const s = store({ claim: Effect.succeed(invalid) });
      await Effect.runPromise(
        workOnce(
          registerModules([
            module(() =>
              Effect.sync(() => {
                called = true;
              }),
            ),
          ]),
        ).pipe(Effect.provideService(JobStore, s.value)),
      );
      expect(s.finishes[0]?.[3]).toBe(true);
    }
    expect(called).toBe(false);
  });
  it('aborts the handler when lease renewal fails and never finishes a stale job', async () => {
    let aborted = false;
    const s = store({
      renew: () => Effect.fail(new BotError({ code: 'lost-lease' })),
    });
    const run = Effect.tryPromise({
      try: (signal) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        ),
      catch: () => new Error('aborted'),
    });
    await Effect.runPromise(
      workOnce(registerModules([module(() => run)]), 5).pipe(
        Effect.provideService(JobStore, s.value),
      ),
    );
    expect(aborted).toBe(true);
    expect(s.finishes).toEqual([]);
  });
  it('persists rate delays without consuming a normal retry', async () => {
    const until = Date.now() + 60000,
      s = store();
    await Effect.runPromise(
      workOnce(
        registerModules([module(() => Effect.fail(new DeferredError(until)))]),
      ).pipe(Effect.provideService(JobStore, s.value)),
    );
    expect(s.finishes[0]?.slice(1)).toEqual([
      'github-rate-limited',
      until,
      false,
    ]);
  });
});
