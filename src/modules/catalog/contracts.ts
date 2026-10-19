import { Context, Effect } from 'effect';
import type { Batch, Candidate } from './model.js';
import type { Prepared } from './evidence.js';
export interface BatchRecord {
  batch_id: string;
  intent: Batch;
  run_id: string | null;
  prepared_sha: string | null;
  branch: string | null;
  evidence_digest: string | null;
  status: string;
}
export interface ReleaseRow {
  package: string;
  version: string;
  state: Candidate['state'];
  security_fix: boolean;
}
export interface DiscoveryCursor {
  cursor: string;
  generation: string;
}
export interface DiscoveredVersion {
  version: string;
  classification: string;
  originRef: string;
}
export class DiscoveryStore extends Context.Service<
  DiscoveryStore,
  {
    start(
      repository: string,
      pkg: string,
      digest: string,
      url: string,
    ): Effect.Effect<void, unknown>;
    cursor(
      repository: string,
      pkg: string,
    ): Effect.Effect<DiscoveryCursor, unknown>;
    commit(
      repository: string,
      pkg: string,
      state: DiscoveryCursor,
      body: Buffer,
      versions: DiscoveredVersion[],
      next: string | null,
    ): Effect.Effect<void, unknown>;
    failed(repository: string, pkg: string): Effect.Effect<void, unknown>;
    due(
      repository: string,
      pkg: string,
      now: number,
    ): Effect.Effect<boolean, unknown>;
  }
>()('ryro/DiscoveryStore') {}
export class CatalogStore extends Context.Service<
  CatalogStore,
  {
    releases(repository: string): Effect.Effect<readonly ReleaseRow[], unknown>;
    batches(repository: string): Effect.Effect<readonly BatchRecord[], unknown>;
    plan(batch: Batch): Effect.Effect<void, unknown>;
    replan(batch: Batch): Effect.Effect<void, unknown>;
    dispatched(
      batch: string,
      key: string,
      runId: number,
    ): Effect.Effect<void, unknown>;
    status(batch: string, status: string): Effect.Effect<void, unknown>;
    prepared(batch: string, digest: string): Effect.Effect<void, unknown>;
    commit(
      batch: string,
      sha: string,
      branch: string,
    ): Effect.Effect<void, unknown>;
    evidence(digest: string): Effect.Effect<Prepared | null, unknown>;
  }
>()('ryro/CatalogStore') {}

export class PageFetcher extends Context.Service<
  PageFetcher,
  {
    fetch(
      url: string,
      authority: string,
      signal?: AbortSignal,
    ): Promise<{ body: Buffer; headers: Headers }>;
  }
>()('ryro/PageFetcher') {}
