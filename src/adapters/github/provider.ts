import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import { GitHub } from './client.js';
import { GitHubProvider } from '../../modules/ci/contracts.js';
import { JobStore } from '../../kernel/contracts/persistence.js';
import { requireThat } from '../../kernel/errors.js';
import type { AdminSettings } from '../../app/config/service.js';

export const githubProviderLayer = (settings: AdminSettings) =>
  Layer.effect(
    GitHubProvider,
    Effect.gen(function* () {
      const jobs = yield* JobStore;
      const sql = yield* SqlClient.SqlClient;
      return GitHubProvider.of({
        configured: (repository) =>
          Boolean(
            settings.bindings[repository] && settings.appId && settings.appKey,
          ),
        forRepository: (repository, signal, job) => {
          const project = settings.projects.find(
            (p) => p.repository === repository,
          );
          const binding = settings.bindings[repository];
          requireThat(
            project && binding && settings.appId && settings.appKey,
            'unconfigured-github',
          );
          return new GitHub(
            repository,
            binding,
            settings.appId,
            settings.appKey,
            fetch,
            {
              canonicalRepository:
                project.canonicalRepository ?? project.repository,
              signal,
              beforeWrite: async (path) => {
                const dispatch = path.endsWith('/dispatches');
                requireThat(
                  settings.mode !== 'observe' &&
                    (dispatch ||
                      (settings.mode === 'publish' &&
                        project.publicationEnabled &&
                        project.independentReviewers.length > 0)),
                  'github-write-disabled',
                );
                requireThat(job, 'github-write-without-job');
                await Effect.runPromise(jobs.renew(job));
                signal?.throwIfAborted();
              },
              blockedUntil: () =>
                Effect.runPromise(
                  Effect.map(
                    sql<{
                      blocked_until: Date;
                    }>`SELECT blocked_until FROM github_limits WHERE installation_id=${binding.installationId}`,
                    (rows) =>
                      rows[0] ? new Date(rows[0].blocked_until).getTime() : 0,
                  ),
                ),
              cooldown: (until) =>
                Effect.runPromise(
                  Effect.asVoid(
                    sql`INSERT INTO github_limits (installation_id,blocked_until) VALUES (${binding.installationId},to_timestamp(${until / 1000})) ON CONFLICT(installation_id) DO UPDATE SET blocked_until=GREATEST(github_limits.blocked_until,EXCLUDED.blocked_until)`,
                  ),
                ),
            },
          );
        },
      });
    }),
  );
