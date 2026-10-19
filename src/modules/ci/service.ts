import { Cause, Effect, Layer } from 'effect';
import { CIStore, PullTracker, WorkflowDispatch } from './contracts.ts';
import {
  JobStore,
  OperationStore,
} from '../../kernel/contracts/persistence.ts';
import { DeferredError, remote } from '../../kernel/operations.ts';
import { requireThat } from '../../kernel/errors.ts';

export const pullTrackerLayer = Layer.effect(
  PullTracker,
  Effect.gen(function* () {
    const store = yield* CIStore;
    const jobs = yield* JobStore;
    return PullTracker.of({
      remember: (repository, pulls) => store.remember(repository, pulls),
      snapshot: (repository, api) =>
        Effect.gen(function* () {
          let scan = yield* store.scan(repository);
          for (let count = 0; count < 2 && !scan.complete; count++) {
            const page = yield* remote(() =>
              api.get<import('./model.ts').Pull[]>(
                `/repos/${repository}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${scan.page}`,
              ),
            );
            requireThat(
              Array.isArray(page) && page.length <= 100,
              'invalid-pull-page',
            );
            yield* store.page(repository, scan.page, page);
            scan = yield* store.scan(repository);
          }
          if (!scan.complete)
            yield* jobs.request(repository, {
              kind: 'ci.reconcile',
              payload: {},
              priority: 0,
            });
          const old = yield* store.pulls(repository);
          const pulls = yield* remote(() => api.pulls());
          const current = new Map(pulls.map((p) => [p.number, p]));
          // A tracked PR can have closed while the bot was offline.
          for (const previous of old)
            if (!current.has(previous.number))
              current.set(
                previous.number,
                previous.state === 'closed'
                  ? previous
                  : yield* remote(() =>
                      api.get<import('./model.ts').Pull>(
                        `/repos/${repository}/pulls/${previous.number}`,
                      ),
                    ),
              );
          const snapshot = [...current.values()];
          yield* store.remember(repository, snapshot);
          return { complete: scan.complete, pulls: snapshot };
        }),
    });
  }),
);

export const workflowDispatchLayer = Layer.effect(
  WorkflowDispatch,
  Effect.gen(function* () {
    const store = yield* OperationStore;
    return WorkflowDispatch.of({
      once: (spec, api) =>
        Effect.gen(function* () {
          const old = yield* store.get(spec.key);
          if (old) {
            requireThat(
              old.repository === spec.repository &&
                old.batch_id === spec.batchId,
              'operation-context-mismatch',
            );
            if (old.state === 'complete') {
              const receipt = old.receipt;
              requireThat(
                receipt &&
                  typeof receipt === 'object' &&
                  'workflow_run_id' in receipt &&
                  Number.isSafeInteger(receipt.workflow_run_id),
                'dispatch-receipt-missing',
              );
              return receipt.workflow_run_id as number;
            }
            if (old.state !== 'waiting') return null;
            if (old.retry_at && new Date(old.retry_at).getTime() > Date.now())
              return yield* new DeferredError(new Date(old.retry_at).getTime());
          }
          if (
            !(yield* store.begin(
              spec.repository,
              spec.batchId,
              spec.key,
              spec.kind,
            ))
          )
            return null;
          const result = yield* remote(() =>
            api.dispatch(spec.workflow, spec.ref, spec.inputs),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const error = Cause.squash(cause);
                if (error instanceof DeferredError)
                  yield* store.defer(spec.key, error.retryAt);
                else yield* store.uncertain(spec.key);
                return yield* Effect.failCause(cause);
              }),
            ),
          );
          requireThat(
            Number.isSafeInteger(result?.workflow_run_id),
            'dispatch-receipt-missing',
          );
          yield* store.complete(spec.key, result);
          return result.workflow_run_id;
        }),
    });
  }),
);
