import { Context, Effect } from 'effect';
import type { GitHubAPI, Pull, Run } from './model.js';
export class GitHubProvider extends Context.Service<
  GitHubProvider,
  {
    configured(repository: string): boolean;
    forRepository(
      repository: string,
      signal?: AbortSignal,
      job?: import('../../kernel/contracts/jobs.js').Job,
    ): GitHubAPI;
  }
>()('ryro/GitHubProvider') {}
export class CIStore extends Context.Service<
  CIStore,
  {
    observe(repository: string, run: Run): Effect.Effect<void, unknown>;
    readonly tracked: (repository: string) => Effect.Effect<Run[], unknown>;
    scan(
      repository: string,
    ): Effect.Effect<{ page: number; complete: boolean }, unknown>;
    page(
      repository: string,
      page: number,
      pulls: Pull[],
    ): Effect.Effect<void, unknown>;
    pulls(repository: string): Effect.Effect<Pull[], unknown>;
    remember(repository: string, pulls: Pull[]): Effect.Effect<void, unknown>;
  }
>()('ryro/CIStore') {}

export class PullTracker extends Context.Service<
  PullTracker,
  {
    remember(repository: string, pulls: Pull[]): Effect.Effect<void, unknown>;
    snapshot(
      repository: string,
      api: GitHubAPI,
    ): Effect.Effect<{ complete: boolean; pulls: Pull[] }, unknown>;
  }
>()('ryro/PullTracker') {}

export interface DispatchRequest {
  repository: string;
  batchId: string;
  key: string;
  kind: string;
  workflow: string;
  ref: string;
  inputs: Record<string, string>;
}
export class WorkflowDispatch extends Context.Service<
  WorkflowDispatch,
  {
    once(
      request: DispatchRequest,
      api: GitHubAPI,
    ): Effect.Effect<number | null, unknown>;
  }
>()('ryro/WorkflowDispatch') {}
