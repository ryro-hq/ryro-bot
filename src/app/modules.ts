import { Effect, Schema } from 'effect';
import { JobStore, AuditStore } from '../kernel/contracts/persistence.js';
import type { JobIntent } from '../kernel/contracts/persistence.js';
import type { BotModule } from '../kernel/contracts/modules.js';
import { registerModules } from '../kernel/modules.js';
import { requireThat } from '../kernel/errors.js';
import { request } from '../kernel/jobs.js';
import { remote } from '../kernel/operations.js';
import {
  CatalogStore,
  DiscoveryStore,
  PageFetcher,
} from '../modules/catalog/contracts.js';
import {
  CIStore,
  GitHubProvider,
  PullTracker,
  WorkflowDispatch,
} from '../modules/ci/contracts.js';
import { discover } from '../modules/catalog/discovery.js';
import { reconcileProject } from '../modules/catalog/reconcile.js';
import { reconcileCI } from '../modules/ci/reconcile.js';
import { routeOpenPulls } from '../modules/reviews/service.js';
import type { AutomationSettings } from '../modules/contracts/settings.js';
import { enabled } from './config/registry.js';

type Services =
  | JobStore
  | AuditStore
  | CatalogStore
  | DiscoveryStore
  | PageFetcher
  | CIStore
  | GitHubProvider
  | PullTracker
  | WorkflowDispatch;
const empty = Schema.decodeUnknownSync(Schema.Struct({}));
const discovery = Schema.decodeUnknownSync(
  Schema.Struct({ package: Schema.String }),
);
const ci = Schema.decodeUnknownSync(
  Schema.Struct({ runId: Schema.optional(Schema.Number) }),
);
const changes = new Set([
  'push',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_run',
  'check_suite',
  'workflow_run',
  'status',
]);

export function builtinModules(settings: AutomationSettings) {
  const projectFor = (repository: string, module: string) => {
    const project = settings.projects.find((p) => p.repository === repository);
    requireThat(
      project && enabled(project, module),
      'unregistered-or-disabled-module',
    );
    return project;
  };
  const requests = (repository: string, module: string): JobIntent[] => {
    const project = settings.projects.find((p) => p.repository === repository);
    return project && enabled(project, module)
      ? [
          {
            kind: module + '.reconcile',
            payload: {},
            priority: module === 'ci' ? 0 : 10,
          },
        ]
      : [];
  };
  const scheduled = (module: string) =>
    Effect.gen(function* () {
      for (const project of settings.projects)
        for (const intent of requests(project.repository, module))
          yield* request(project.repository, intent);
    });
  const modules: BotModule<Services>[] = [
    {
      id: 'ci',
      jobs: [
        {
          kind: 'ci.reconcile',
          payloadVersion: 1,
          validate: (payload) => {
            const value = ci(payload);
            requireThat(
              value.runId === undefined ||
                (Number.isSafeInteger(value.runId) && value.runId > 0),
              'invalid-run-id',
            );
            return value;
          },
          run: (job) =>
            reconcileCI(settings, projectFor(job.repository, 'ci'), job),
        },
      ],
      webhook: (repository, event, payload) => {
        if (!changes.has(event)) return [];
        const intents = requests(repository, 'ci');
        const id = (payload as { workflow_run?: { id?: number } })?.workflow_run
          ?.id;
        if (event === 'workflow_run' && Number.isSafeInteger(id) && id! > 0)
          return intents.map((i) => ({
            ...i,
            scope: 'run:' + id,
            payload: { runId: id },
          }));
        return intents;
      },
      schedule: () => scheduled('ci'),
    },
    {
      id: 'catalog',
      requires: ['ci'],
      jobs: [
        {
          kind: 'catalog.reconcile',
          payloadVersion: 1,
          validate: empty,
          run: (job) =>
            reconcileProject(
              settings,
              projectFor(job.repository, 'catalog'),
              job,
            ),
        },
        {
          kind: 'catalog.discover',
          payloadVersion: 1,
          validate: discovery,
          run: (job) =>
            Effect.gen(function* () {
              const project = projectFor(job.repository, 'catalog');
              const pkg = (job.payload as { package: string }).package;
              const channel = project.packages[pkg]?.discovery;
              requireThat(channel, 'unknown-discovery-channel');
              const result = yield* discover(
                project.repository,
                pkg,
                channel,
                2,
              );
              if (!result.complete)
                yield* request(project.repository, {
                  kind: 'catalog.discover',
                  payload: { package: pkg },
                  scope: pkg,
                  priority: 20,
                });
              else
                yield* request(project.repository, {
                  kind: 'catalog.reconcile',
                  payload: {},
                });
            }),
        },
      ],
      webhook: (repository, event) =>
        changes.has(event) ? requests(repository, 'catalog') : [],
      schedule: (now) =>
        Effect.gen(function* () {
          yield* scheduled('catalog');
          const store = yield* DiscoveryStore;
          for (const project of settings.projects)
            if (enabled(project, 'catalog'))
              for (const [pkg, config] of Object.entries(project.packages)) {
                if (
                  config.discovery &&
                  (yield* store.due(project.repository, pkg, now))
                )
                  yield* request(project.repository, {
                    kind: 'catalog.discover',
                    payload: { package: pkg },
                    scope: pkg,
                    priority: 20,
                  });
              }
        }),
    },
    {
      id: 'reviews',
      requires: ['ci'],
      jobs: [
        {
          kind: 'reviews.reconcile',
          payloadVersion: 1,
          validate: empty,
          run: (job) =>
            Effect.gen(function* () {
              const project = projectFor(job.repository, 'reviews');
              const provider = yield* GitHubProvider;
              if (!provider.configured(project.repository)) return;
              const signal = yield* Effect.abortSignal;
              const api = provider.forRepository(
                project.repository,
                signal,
                job,
              );
              yield* routeOpenPulls(
                settings,
                project,
                job,
                api,
                yield* remote(() => api.pulls()),
              );
            }),
        },
      ],
      webhook: (repository, event) =>
        changes.has(event) ? requests(repository, 'reviews') : [],
      schedule: () => scheduled('reviews'),
    },
  ];
  // Drain durable jobs written by earlier bot versions without changing their IDs.
  modules.push({
    id: 'compatibility',
    jobs: [
      {
        kind: 'reconcile',
        payloadVersion: 1,
        validate: empty,
        run: (job) =>
          Effect.gen(function* () {
            for (const module of ['ci', 'catalog', 'reviews'])
              for (const intent of requests(job.repository, module))
                yield* request(job.repository, intent);
          }),
      },
      {
        kind: 'discover',
        payloadVersion: 1,
        validate: discovery,
        run: (job) =>
          request(job.repository, {
            kind: 'catalog.discover',
            payload: job.payload,
            scope: (job.payload as { package: string }).package,
            priority: 20,
          }),
      },
    ],
  });
  return registerModules(modules);
}
