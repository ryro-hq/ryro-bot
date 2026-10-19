import { Effect } from 'effect';
import { CatalogStore } from './contracts.ts';
import type { BatchRecord } from './contracts.ts';
import {
  GitHubProvider,
  PullTracker,
  WorkflowDispatch,
} from '../ci/contracts.ts';
import { parse } from 'smol-toml';
import { BotError, requireThat } from '../../kernel/errors.ts';
import { canonical, sha256 } from '../../kernel/values.ts';
import type { Candidate } from './model.ts';
import type { Project } from '../contracts/project.ts';
import type { AutomationSettings as Settings } from '../contracts/settings.ts';
import { audit, saveEvidence } from '../../kernel/audit.ts';
import { renew } from '../../kernel/jobs.ts';
import type { Job } from '../../kernel/contracts/jobs.ts';
import type { GitHubAPI as GitHub, Pull } from '../ci/model.ts';
import { remote } from '../../kernel/operations.ts';

import { admitBaseConfig } from '../../kernel/policy.ts';
import { policyDigest } from '../contracts/policy.ts';
import { plan, reconcile } from './planner.ts';
import type { Snapshot } from './planner.ts';
import {
  admitPrepared,
  blobSha,
  unzipPrepared,
  verifyCatalogAddition,
} from './evidence.ts';

const marker = (id: string) => '<!-- ryro-bot:batch=' + id + ' -->';
export const batchFromBody = (body: string | null) =>
  /<!-- ryro-bot:batch=([0-9a-f]{64}) -->/.exec(body ?? '')?.[1];

export const reconcileProject = (
  settings: Settings,
  project: Project,
  job: Job,
  github?: GitHub,
) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore;
    const provider = yield* GitHubProvider;
    const binding = settings.bindings[project.repository];
    if (
      !binding ||
      !provider.configured(project.repository) ||
      !settings.appLogin
    ) {
      yield* Effect.logInfo('Reconciliation waiting for installation binding', {
        repository: project.repository,
      });
      return;
    }
    const signal = yield* Effect.abortSignal;
    const api =
      github ?? provider.forRepository(project.repository, signal, job);
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
    const releases = yield* store.releases(project.repository);
    const candidates: Candidate[] = releases.flatMap((r) =>
      (project.packages[r.package]?.profiles ?? []).map((profile) => ({
        ...r,
        profile,
        securityFix: r.security_fix,
      })),
    );
    const records = yield* store.batches(project.repository);
    const available = candidates.filter(
      (candidate) =>
        !records.some(
          (record) =>
            record.intent.package === candidate.package &&
            record.intent.profile === candidate.profile &&
            record.intent.versions.includes(candidate.version),
        ),
    );
    const desired = plan(
      project,
      baseSha,
      settings.revision,
      available,
      admitted,
      {
        catalog: catalogBytes.length,
        lock: lockBytes.length,
      },
    );
    // Historical batches reserve their versions, including closed PRs. Group only
    // unreserved candidates so one old version cannot starve a newer batch.
    for (const batch of desired.batches) yield* store.plan(batch);
    const currentRecords = yield* store.batches(project.repository);
    const history = yield* (yield* PullTracker).snapshot(
      project.repository,
      api,
    );
    if (!history.complete) return;
    const pulls = history.pulls;
    // A write may have succeeded before its receipt was persisted, and the PR
    // may have closed while the bot was offline. Resolve known heads explicitly.
    for (const record of currentRecords)
      if (
        record.prepared_sha &&
        !pulls.some(
          (pr) =>
            batchFromBody(pr.body) === record.batch_id ||
            pr.head.ref === 'ryro-bot/' + record.batch_id,
        )
      ) {
        const head =
          (project.canonicalRepository ?? project.repository).split('/')[0] +
          ':ryro-bot/' +
          record.batch_id;
        const recovered = yield* remote(() =>
          api.list<Pull>('/pulls?state=all&head=' + encodeURIComponent(head)),
        );
        yield* (yield* PullTracker).remember(project.repository, recovered);
        pulls.push(
          ...recovered.filter(
            (pr) => !pulls.some((old) => old.number === pr.number),
          ),
        );
      }
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
    for (const record of currentRecords)
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
      currentRecords.map((r) => r.intent),
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

    for (const record of currentRecords) {
      yield* renew(job);
      const decision = decisions.find((d) => d.batchId === record.batch_id)!;
      const currentReleases = yield* store.releases(project.repository);
      if (
        record.intent.versions.some(
          (version) =>
            !currentReleases.some(
              (release) =>
                release.package === record.intent.package &&
                release.version === version &&
                release.state === 'discovered',
            ),
        )
      ) {
        yield* store.status(record.batch_id, 'security-hold');
        continue;
      }
      if (decision.action === 'replan' && record.prepared_sha) {
        yield* store.status(record.batch_id, 'base-changed-manual-review');
        continue;
      }
      if (
        decision.action === 'replan' &&
        !record.prepared_sha &&
        !pulls.some(
          (pr) =>
            batchFromBody(pr.body) === record.batch_id ||
            pr.head.ref === 'ryro-bot/' + record.batch_id,
        )
      ) {
        const next = {
          ...record.intent,
          baseSha,
          policyRevision: settings.revision,
        };
        if (next) {
          yield* store.replan(next);
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
        const runId = yield* (yield* WorkflowDispatch).once(
          {
            repository: project.repository,
            batchId: batch.id,
            key: operationKey,
            kind: 'prepare-dispatch',
            workflow: project.preparationWorkflow,
            ref: project.baseBranch,
            inputs: {
              expected_sha: batch.baseSha,
              policy_revision: batch.policyRevision,
              batch_id: batch.id,
              package: batch.package,
              profile: batch.profile,
              versions: JSON.stringify(batch.versions),
            },
          },
          api,
        );
        if (runId === null) {
          yield* audit('dispatch-recovery-required', {
            ...context,
            evidence: { operationKey },
          });
          continue;
        }
        yield* store.dispatched(batch.id, operationKey, runId);
        yield* audit('prepare-dispatched', {
          ...context,
          evidence: { batchId: batch.id, runId },
        });
        continue;
      }
      if (!record.evidence_digest) {
        const runId = Number(record.run_id),
          run = yield* remote(() => api.run(runId));
        if (run.status !== 'completed') continue;
        if (run.conclusion !== 'success') {
          yield* store.status(batch.id, 'preparation-failed');
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
        const [artifact] = matches;
        requireThat(
          matches.length === 1 && artifact,
          'missing-preparation-artifact',
        );
        const bytes = yield* remote(() =>
          api.artifact(artifact.id, artifact.digest),
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
        yield* store.prepared(batch.id, digest);
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
    const store = yield* CatalogStore;
    const batch = record.intent,
      branch = record.branch ?? 'ryro-bot/' + batch.id;
    const doc = record.evidence_digest
      ? yield* store.evidence(record.evidence_digest)
      : null;
    requireThat(
      doc && sha256(canonical(doc)) === record.evidence_digest,
      'stored-evidence-integrity',
    );
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
      yield* store.commit(batch.id, commit.sha, branch);
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
      const fresh = (yield* (yield* PullTracker).snapshot(
        project.repository,
        api,
      )).pulls;
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
    const [pr] = pulls;
    requireThat(pulls.length === 1 && pr, 'duplicate-prs');
    yield* (yield* PullTracker).remember(project.repository, pulls);
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
      yield* (yield* WorkflowDispatch).once(
        {
          repository: project.repository,
          batchId: batch.id,
          key,
          kind: 'qualify-dispatch',
          workflow: project.qualificationWorkflow,
          ref: branch,
          inputs: { expected_sha: record.prepared_sha! },
        },
        api,
      );
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
