import { Effect } from 'effect';
import { CIStore, GitHubProvider, PullTracker } from './contracts.ts';
import type { AutomationSettings } from '../contracts/settings.ts';
import type { Project } from '../contracts/project.ts';
import type { Job } from '../../kernel/contracts/jobs.ts';
import { remote } from '../../kernel/operations.ts';
import { requireThat } from '../../kernel/errors.ts';

export const reconcileCI = (
  settings: AutomationSettings,
  project: Project,
  job: Job,
) =>
  Effect.gen(function* () {
    const provider = yield* GitHubProvider;
    if (!provider.configured(project.repository)) return;
    const signal = yield* Effect.abortSignal;
    const api = provider.forRepository(project.repository, signal, job);
    const store = yield* CIStore;
    const binding = settings.bindings[project.repository];
    const observe = (id: number) =>
      Effect.gen(function* () {
        // Webhooks are hints. Read the authoritative attempt and state, including reruns.
        const run = yield* remote(() => api.run(id));
        requireThat(
          run.repository.id === binding.repositoryId,
          'workflow-repository-mismatch',
        );
        yield* store.observe(project.repository, run);
      });
    const payload = job.payload as { runId?: number };
    const seen = new Set<number>();
    if (payload.runId) {
      yield* observe(payload.runId);
      seen.add(payload.runId);
    }
    for (const workflow of project.workflows ?? [
      project.preparationWorkflow,
      project.qualificationWorkflow,
    ]) {
      if (!workflow) continue;
      const runs = yield* remote(() => api.runs(workflow));
      for (const run of runs) {
        requireThat(
          run.repository.id === binding.repositoryId,
          'workflow-repository-mismatch',
        );
        yield* store.observe(project.repository, run);
        seen.add(run.id);
      }
    }
    for (const run of yield* store.tracked(project.repository))
      if (!seen.has(run.id)) yield* observe(run.id);
    yield* (yield* PullTracker).snapshot(project.repository, api);
  });
