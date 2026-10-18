import { routeOpenPulls } from './routing.js';
import { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import { parse } from 'smol-toml';
import { BotError, canonical, requireThat, sha256 } from './domain.js';
import type { Batch, Candidate, Project } from './domain.js';
import type { Settings } from './config.js';
import { audit, renew, saveEvidence } from './db.js';
import type { Job } from './db.js';
import { GitHub } from './github.js';
import type { Pull } from './github.js';
import { admitBaseConfig, policyDigest, route } from './policy.js';
import { plan, reconcile } from './planner.js';
import type { Snapshot } from './planner.js';
import {
  admitPrepared,
  blobSha,
  unzipPrepared,
  verifyCatalogAddition,
} from './evidence.js';
import type { Prepared } from './evidence.js';

export const remote = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) =>
      error instanceof BotError
        ? error
        : new BotError({ code: 'remote-operation-failed' }),
  });
const marker = (id: string) => '<!-- ryro-bot:batch=' + id + ' -->';
export const batchFromBody = (body: string | null) =>
  /<!-- ryro-bot:batch=([0-9a-f]{64}) -->/.exec(body ?? '')?.[1];

interface BatchRecord {
  batch_id: string;
  intent: Batch;
  run_id: string | null;
  prepared_sha: string | null;
  branch: string | null;
  evidence_digest: string | null;
  status: string;
}

export const reconcileProject = (
  settings: Settings,
  project: Project,
  job: Job,
  github?: GitHub,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    const binding = settings.bindings[project.repository];
    if (!binding || !settings.appId || !settings.appKey || !settings.appLogin) {
      yield* Effect.logInfo('Reconciliation waiting for installation binding', {
        repository: project.repository,
      });
      return;
    }
    const api =
      github ??
      new GitHub(project.repository, binding, settings.appId, settings.appKey);
    const baseSha = yield* remote(() => api.base(project.baseBranch));
    const configBytes = yield* remote(() =>
      api.file('.ryro-bot.toml', baseSha),
    );
    const configDigest = yield* Effect.try({
      try: () =>
        admitBaseConfig(
          configBytes.toString('utf8'),
          project,
          settings.revision,
        ),
      catch: () => new BotError({ code: 'base-opt-in-rejected' }),
    });
    const catalogBytes = yield* remote(() => api.file('catalog.toml', baseSha));
    const lockBytes = yield* remote(() => api.file('Catalog.lock', baseSha));
    const catalog = parse(catalogBytes.toString('utf8')) as unknown as {
      schema: number;
      releases: {
        name: string;
        version: string;
        combinations: { variant: string; system: string }[];
      }[];
    };
    requireThat(
      catalog.schema === 2 && Array.isArray(catalog.releases),
      'pilot-requires-catalog-v2',
    );
    const admitted = catalog.releases.flatMap((r) =>
      [...new Set(r.combinations.map((c) => c.variant))].map((profile) => ({
        package: r.name,
        version: r.version,
        profile,
        systems: r.combinations
          .filter((c) => c.variant === profile)
          .map((c) => c.system),
      })),
    );
    const releases = yield* sql<{
      package: string;
      version: string;
      state: Candidate['state'];
      security_fix: boolean;
    }>`SELECT package,version,state,security_fix FROM releases WHERE repository=${project.repository} ORDER BY package,version LIMIT 100001`;
    requireThat(
      releases.length <= 100000,
      'inventory-planning-limit-partition-required',
    );
    const candidates: Candidate[] = releases.flatMap((r) =>
      (project.packages[r.package]?.profiles ?? []).map((profile) => ({
        ...r,
        profile,
        securityFix: r.security_fix,
      })),
    );
    const desired = plan(
      project,
      baseSha,
      settings.revision,
      candidates,
      admitted,
      {
        catalog: catalogBytes.length,
        lock: lockBytes.length,
      },
    );
    for (const batch of desired.batches) {
      yield* sql`INSERT INTO batches (batch_id,repository,base_sha,policy_revision,intent) VALUES (${batch.id},${project.repository},${baseSha},${settings.revision},${pg.json(batch)})
      ON CONFLICT (batch_id) DO UPDATE SET base_sha=EXCLUDED.base_sha,policy_revision=EXCLUDED.policy_revision,intent=EXCLUDED.intent
      WHERE batches.prepared_sha IS NULL AND batches.run_id IS NULL`;
    }
    const records =
      yield* sql<BatchRecord>`SELECT * FROM batches WHERE repository=${project.repository} ORDER BY updated_at,batch_id LIMIT 10001`;
    requireThat(records.length <= 10000, 'batch-snapshot-incomplete');
    const pulls = yield* remote(() => api.pulls());
    yield* routeOpenPulls(settings, project, job, api, pulls);
    const snapshot: Snapshot = {
      complete: true,
      baseSha,
      prs: [],
      branches: {},
    };
    for (const pr of pulls) {
      const batchId =
        batchFromBody(pr.body) ??
        /^ryro-bot\/([0-9a-f]{64})$/.exec(pr.head.ref)?.[1];
      // Count every App PR, including an altered or missing marker.
      snapshot.prs.push({
        batchId: batchId ?? 'unrecognized:' + pr.number,
        number: pr.number,
        state: pr.state,
        author: pr.user.login,
        headSha: pr.head.sha,
        draft: pr.draft,
      });
    }
    for (const record of records)
      if (record.prepared_sha) {
        const head = yield* remote(() =>
          api.ref('ryro-bot/' + record.batch_id),
        );
        if (head)
          snapshot.branches[record.batch_id] = {
            headSha: head,
            preparedSha: record.prepared_sha,
            baseSha: record.intent.baseSha,
            author: settings.appLogin,
            humanCommits: head !== record.prepared_sha,
          };
      }
    const decisions = reconcile(
      records.map((r) => r.intent),
      snapshot,
      settings.appLogin,
      project.limits.openPrs,
    );
    const context = {
      repository: project.repository,
      policyRevision: settings.revision,
      baseSha,
      producedSha: null,
      botVersion: settings.version,
      evidence: {
        configDigest,
        policyDigest: policyDigest(project),
        decisions,
        queued: desired.queued.length,
        mode: settings.mode,
      },
    };
    yield* audit('reconcile', context);
    if (settings.mode === 'observe') return;

    for (const record of records) {
      yield* renew(job);
      const decision = decisions.find((d) => d.batchId === record.batch_id)!;
      if (
        decision.action === 'replan' &&
        !record.prepared_sha &&
        !pulls.some(
          (pr) =>
            batchFromBody(pr.body) === record.batch_id ||
            pr.head.ref === 'ryro-bot/' + record.batch_id,
        )
      ) {
        const next = desired.batches.find((b) => b.id === record.batch_id);
        if (next) {
          yield* sql`UPDATE batches SET base_sha=${next.baseSha},policy_revision=${next.policyRevision},intent=${pg.json(next)},run_id=NULL,evidence_digest=NULL,status='planned',updated_at=clock_timestamp() WHERE batch_id=${record.batch_id} AND prepared_sha IS NULL`;
          yield* audit('base-replanned', {
            ...context,
            evidence: {
              batchId: record.batch_id,
              priorBase: record.intent.baseSha,
            },
          });
        }
        continue;
      }
      if (
        [
          'respect-closed',
          'conflict',
          'replan',
          'preserve-human-work',
          'queued',
        ].includes(decision.action)
      )
        continue;
      const batch = record.intent;
      if (!record.run_id) {
        const operationKey =
          'prepare:' +
          batch.id +
          ':' +
          batch.baseSha +
          ':' +
          batch.policyRevision;
        const existing = yield* sql<{
          state: string;
        }>`SELECT state FROM operations WHERE operation_key=${operationKey}`;
        if (existing.length) {
          // A timed-out dispatch is deliberately not repeated: an operator must reconcile it.
          yield* audit('dispatch-recovery-required', {
            ...context,
            evidence: { operationKey },
          });
          continue;
        }
        yield* sql`INSERT INTO operations (operation_key,repository,batch_id,kind,state) VALUES (${operationKey},${project.repository},${batch.id},'prepare-dispatch','intent')`;
        const result = yield* remote(() =>
          api.dispatch(project.preparationWorkflow, project.baseBranch, {
            expected_sha: batch.baseSha,
            policy_revision: batch.policyRevision,
            batch_id: batch.id,
            package: batch.package,
            profile: batch.profile,
            versions: JSON.stringify(batch.versions),
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* sql`UPDATE operations SET state='uncertain' WHERE operation_key=${operationKey}`;
              return yield* Effect.fail(error);
            }),
          ),
        );
        requireThat(
          Number.isSafeInteger(result?.workflow_run_id),
          'dispatch-receipt-missing',
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE batches SET run_id=${result.workflow_run_id},status='preparing' WHERE batch_id=${batch.id}`;
            yield* sql`UPDATE operations SET state='complete',receipt=${pg.json(result)} WHERE operation_key=${operationKey}`;
          }),
        );
        yield* audit('prepare-dispatched', {
          ...context,
          evidence: { batchId: batch.id, runId: result.workflow_run_id },
        });
        continue;
      }
      if (!record.evidence_digest) {
        const runId = Number(record.run_id),
          run = yield* remote(() => api.run(runId));
        if (run.status !== 'completed') continue;
        if (run.conclusion !== 'success') {
          yield* sql`UPDATE batches SET status='preparation-failed' WHERE batch_id=${batch.id}`;
          continue;
        }
        const artifacts = yield* remote(() =>
          api.list<{
            id: number;
            name: string;
            digest: string;
            expired: boolean;
          }>('/actions/runs/' + runId + '/artifacts', 'artifacts'),
        );
        const matches = artifacts.filter(
          (a) => a.name === 'prepared-' + batch.id + '-' + runId && !a.expired,
        );
        requireThat(matches.length === 1, 'missing-preparation-artifact');
        const bytes = yield* remote(() =>
          api.artifact(matches[0].id, matches[0].digest),
        );
        const document = yield* Effect.try({
          try: () =>
            admitPrepared(
              JSON.parse(unzipPrepared(bytes).toString('utf8')),
              batch,
              run,
              binding.repositoryId,
              project,
            ),
          catch: () => new BotError({ code: 'preparation-evidence-rejected' }),
        });
        const digest = yield* saveEvidence(project.repository, document, {
          runId,
          artifact: matches[0],
          run,
        });
        yield* sql`UPDATE batches SET evidence_digest=${digest},status='prepared' WHERE batch_id=${batch.id}`;
        yield* audit('prepared', {
          ...context,
          evidence: { batchId: batch.id, digest, runId },
        });
        continue;
      }
      if (settings.mode !== 'publish') continue;
      // This gate stays false in the pilot until engine/distribution controls are evidenced.
      requireThat(
        project.publicationEnabled && project.independentReviewers.length > 0,
        'rollout-security-and-independent-review-pending',
      );
      const rules = yield* remote(() => api.rules(project.baseBranch));
      const checks = rules.find((r) => r.type === 'required_status_checks')
        ?.parameters?.required_status_checks as
        | { context: string }[]
        | undefined;
      requireThat(
        project.requiredChecks.every((c) =>
          checks?.some((x) => x.context === c),
        ),
        'required-checks-not-enforced',
      );
      yield* publishPrepared(settings, project, job, record, api, pulls);
    }
  });

const publishPrepared = (
  settings: Settings,
  project: Project,
  job: Job,
  record: BatchRecord,
  api: GitHub,
  initialPulls: Pull[],
) =>
  Effect.gen(function* () {
    const pg = yield* PgClient.PgClient;
    const sql = yield* SqlClient.SqlClient,
      batch = record.intent,
      branch = 'ryro-bot/' + batch.id;
    const [stored] = yield* sql<{
      document: Prepared;
    }>`SELECT document FROM evidence WHERE digest=${record.evidence_digest}`;
    requireThat(
      stored && sha256(canonical(stored.document)) === record.evidence_digest,
      'stored-evidence-integrity',
    );
    const doc = stored.document;
    const assertBase = () =>
      remote(async () =>
        requireThat(
          (await api.base(project.baseBranch)) === batch.baseSha,
          'base-moved-before-write',
        ),
      );
    yield* assertBase();
    const entries: { path: string; sha: string }[] = [];
    if (!record.prepared_sha) {
      for (const file of doc.files) {
        const before = yield* remote(() =>
          api.file(file.path, batch.baseSha),
        ).pipe(
          Effect.catch((e) =>
            e.code === 'github-http-404' && file.beforeBlob === null
              ? Effect.succeed(null)
              : Effect.fail(e),
          ),
        );
        requireThat(
          (before ? blobSha(before) : null) === file.beforeBlob,
          'base-file-mismatch',
        );
        const after = Buffer.from(file.content, 'base64');
        if (file.path === 'catalog.toml') {
          requireThat(before, 'catalog-missing');
          verifyCatalogAddition(before, after, batch, project);
        }
        if (file.path === 'Catalog.lock')
          requireThat(
            after.length <= project.limits.lockBytes,
            'lock-byte-limit',
          );
        const blob = yield* remote(() => api.createBlob(after));
        entries.push({ path: file.path, sha: blob.sha });
      }
      yield* renew(job);
      yield* assertBase();
      const commit = yield* remote(() =>
        api.createCommit(
          batch.baseSha,
          entries,
          'catalog: add ' +
            batch.package +
            ' ' +
            batch.versions.join(', ') +
            '\n\n' +
            marker(batch.id),
        ),
      );
      yield* sql`UPDATE batches SET prepared_sha=${commit.sha},branch=${branch} WHERE batch_id=${batch.id}`;
      record.prepared_sha = commit.sha;
    }
    yield* renew(job);
    yield* assertBase();
    const head = yield* remote(() => api.ref(branch));
    requireThat(!head || head === record.prepared_sha, 'preserve-human-branch');
    if (!head)
      yield* remote(() => api.createBranch(branch, record.prepared_sha!));
    let pulls = initialPulls.filter(
      (pr) => batchFromBody(pr.body) === batch.id || pr.head.ref === branch,
    );
    if (!pulls.length) {
      const fresh = yield* remote(() => api.pulls());
      pulls = fresh.filter(
        (pr) => batchFromBody(pr.body) === batch.id || pr.head.ref === branch,
      );
      if (!pulls.length) {
        requireThat(
          fresh.filter(
            (pr) => pr.state === 'open' && pr.user.login === settings.appLogin,
          ).length < project.limits.openPrs,
          'open-pr-budget',
        );
        yield* renew(job);
        yield* assertBase();
        pulls = [
          yield* remote(() =>
            api.createDraft(
              branch,
              project.baseBranch,
              'catalog: add ' + batch.package + ' ' + batch.versions.join(', '),
              marker(batch.id) +
                '\n\nAdds versions without changing defaults.\n\nBase: `' +
                batch.baseSha +
                '`\nPolicy: `' +
                batch.policyRevision +
                '`\nPreparation evidence: `' +
                record.evidence_digest +
                '`\n\nHuman review and qualification of this exact head are required.',
            ),
          ),
        ];
      }
    }
    requireThat(pulls.length === 1, 'duplicate-prs');
    const pr = pulls[0];
    if (pr.state === 'closed') return;
    requireThat(
      pr.user.login === settings.appLogin &&
        pr.head.sha === record.prepared_sha,
      'preserve-human-pr',
    );
    // App-created PRs trigger pull_request CI. Dispatch only if no run exists for this head.
    const runs = yield* remote(() => api.runs(project.qualificationWorkflow));
    if (
      pr.created_at &&
      Date.now() - Date.parse(pr.created_at) > 900000 &&
      !runs.some((r) => r.head_sha === record.prepared_sha)
    ) {
      const key = 'qualify:' + record.prepared_sha;
      const old =
        yield* sql`SELECT 1 FROM operations WHERE operation_key=${key}`;
      if (!old.length) {
        yield* sql`INSERT INTO operations (operation_key,repository,batch_id,kind,state) VALUES (${key},${project.repository},${batch.id},'qualify-dispatch','intent')`;
        yield* remote(() =>
          api.dispatch(project.qualificationWorkflow, branch, {
            expected_sha: record.prepared_sha!,
          }),
        );
        yield* sql`UPDATE operations SET state='complete' WHERE operation_key=${key}`;
      }
    }
    const reviewers = route(
      project,
      doc.files.map((f) => f.path),
      pr.user.login,
    ).reviewers;
    if (reviewers.length) {
      const requested = yield* remote(() =>
        api.get<{ users: { login: string }[] }>(
          `/repos/${project.repository}/pulls/${pr.number}/requested_reviewers`,
        ),
      );
      const missing = reviewers
        .map((r) => r.slice(1))
        .filter(
          (r) =>
            !requested.users.some(
              (u) => u.login.toLowerCase() === r.toLowerCase(),
            ),
        );
      if (missing.length)
        yield* remote(() => api.requestReview(pr.number, missing));
    }
    yield* audit('draft-published', {
      repository: project.repository,
      policyRevision: batch.policyRevision,
      baseSha: batch.baseSha,
      producedSha: record.prepared_sha,
      botVersion: settings.version,
      evidence: {
        batchId: batch.id,
        pr: pr.number,
        preparationDigest: record.evidence_digest,
      },
    });
  });
