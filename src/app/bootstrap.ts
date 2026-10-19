import { Cause, Effect, Layer } from 'effect';
import type { Settings } from './config/service.ts';
import { builtinModules } from './modules.ts';
import { checkDurability } from '../adapters/postgres/client.ts';
import { checkMigrations } from '../adapters/postgres/migrations.ts';
import { persistenceLayer } from '../adapters/postgres/layers.ts';
import { githubProviderLayer } from '../adapters/github/provider.ts';
import { pageFetcherLayer } from '../adapters/http/client.ts';
import { webhookServer } from '../adapters/http/webhooks.ts';
import {
  pullTrackerLayer,
  workflowDispatchLayer,
} from '../modules/ci/service.ts';
import { JobStore } from '../kernel/contracts/persistence.ts';
import { schedule } from '../kernel/scheduler.ts';
import { workOnce } from '../kernel/worker.ts';

export const registerProjects = (settings: Settings) =>
  Effect.gen(function* () {
    const jobs = yield* JobStore;
    const projects: Settings['projects'] = [];
    const bindings: Settings['bindings'] = {};
    for (const project of settings.projects) {
      const binding = settings.bindings[project.repository];
      const canonical = project.canonicalRepository ?? project.repository;
      const storageKey = yield* jobs.register(
        project.repository,
        project.repositoryId ?? binding?.repositoryId,
        canonical,
        project.aliases ?? [],
      );
      projects.push({
        ...project,
        repository: storageKey,
        canonicalRepository: canonical,
      });
      if (binding) bindings[storageKey] = binding;
    }
    return { ...settings, projects, bindings };
  });

const start = (settings: Settings) =>
  Effect.gen(function* () {
    const runtime = yield* registerProjects(settings);
    const registry = builtinModules(runtime);
    const jobs = yield* JobStore;
    const run = Effect.gen(function* () {
      const server = webhookServer(
        runtime,
        (id, repository, event, body) =>
          Effect.runPromise(
            jobs.receive(
              id,
              repository,
              event,
              body,
              registry.webhook(
                repository,
                event,
                JSON.parse(body.toString('utf8')),
              ),
            ),
          ),
        () => Effect.runPromise(jobs.healthy),
      );
      yield* Effect.acquireRelease(
        Effect.tryPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once('error', reject);
              server.listen(runtime.port, runtime.host, resolve);
            }),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeIdleConnections();
              }),
          ),
      );
      yield* Effect.logInfo('Ryro bot ready', {
        mode: runtime.mode,
        version: runtime.version,
        port: runtime.port,
        workers: runtime.workerConcurrency ?? 4,
      });
      yield* Effect.forkScoped(
        schedule(registry).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning('Scheduler unavailable'),
          ),
          Effect.andThen(Effect.sleep(runtime.schedulerSeconds * 1000)),
          Effect.forever,
        ),
      );
      for (let worker = 0; worker < (runtime.workerConcurrency ?? 4); worker++)
        yield* Effect.forkScoped(
          workOnce(registry).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning('Worker unavailable'),
            ),
            Effect.andThen(Effect.sleep('1 second')),
            Effect.forever,
          ),
        );
      yield* Effect.never;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          pullTrackerLayer,
          workflowDispatchLayer,
          githubProviderLayer(runtime),
          pageFetcherLayer,
        ),
      ),
    );
    yield* run;
  });

export const service = (settings: Settings) =>
  Effect.gen(function* () {
    // The deployment runs migrations explicitly, before accepting HTTP or claiming work.
    yield* checkMigrations;
    yield* checkDurability;
    yield* start(settings).pipe(Effect.provide(persistenceLayer));
  });
