import { canonical, component, gitSha, sha256 } from '../../kernel/values.ts';
import { requireThat } from '../../kernel/errors.ts';
import type { Batch, Candidate } from './model.ts';
import type { Project } from '../contracts/project.ts';

export function versionCompare(a: string, b: string): number {
  const left = a.match(/\d+|\D+/g) ?? [],
    right = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i],
      y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const result =
      /^\d+$/.test(x) && /^\d+$/.test(y)
        ? BigInt(x) > BigInt(y)
          ? 1
          : BigInt(x) < BigInt(y)
            ? -1
            : 0
        : x.localeCompare(y, 'en');
    if (result) return result;
  }
  return 0;
}

export function plan(
  project: Project,
  baseSha: string,
  revision: string,
  candidates: Candidate[],
  admitted: {
    package: string;
    version: string;
    profile: string;
    systems: string[];
  }[],
  sizes: { catalog: number; lock: number },
) {
  gitSha(baseSha);
  gitSha(revision);
  const groups = new Map<string, Map<string, Candidate>>(),
    queued: { candidate: Candidate; reason: string }[] = [],
    batches: Batch[] = [];
  const known = new Set(
    admitted.map((r) => canonical([r.package, r.version, r.profile])),
  );
  let combinations = admitted.reduce((n, r) => n + r.systems.length, 0),
    catalog = sizes.catalog,
    lock = sizes.lock;
  for (const item of candidates) {
    [item.package, item.version, item.profile].forEach(component);
    if (known.has(canonical([item.package, item.version, item.profile])))
      continue;
    if (
      item.state !== 'discovered' ||
      !project.packages[item.package]?.profiles.includes(item.profile)
    ) {
      queued.push({
        candidate: item,
        reason: 'security-hold-or-unregistered-profile',
      });
      continue;
    }
    const key = canonical([item.package, item.profile]);
    const entries = groups.get(key) ?? new Map();
    const previous = entries.get(item.version);
    entries.set(item.version, {
      ...item,
      securityFix: Boolean(item.securityFix || previous?.securityFix),
    });
    groups.set(key, entries);
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      Number([...b.values()].some((v) => v.securityFix)) -
      Number([...a.values()].some((v) => v.securityFix)),
  );
  for (const entries of ordered) {
    const rows = [...entries.values()].sort(
      (a, b) =>
        Number(Boolean(b.securityFix)) - Number(Boolean(a.securityFix)) ||
        versionCompare(b.version, a.version),
    );
    for (let i = 0; i < rows.length; i += project.limits.versionsPerBatch) {
      const selected = rows.slice(i, i + project.limits.versionsPerBatch),
        first = selected[0];
      requireThat(first, 'empty-update-batch');
      const systems = new Set(
        admitted
          .filter(
            (r) => r.package === first.package && r.profile === first.profile,
          )
          .flatMap((r) => r.systems),
      );
      const cost = systems.size * selected.length,
        bytes = cost * project.limits.estimatedBytesPerCombination;
      if (
        systems.size === 0 ||
        combinations + cost > project.limits.combinations ||
        (combinations + cost) * project.hosts.length >
          project.limits.actionsMatrixRows ||
        catalog + bytes > project.limits.catalogBytes ||
        lock + bytes > project.limits.lockBytes
      ) {
        queued.push(
          ...selected.map((candidate) => ({
            candidate,
            reason: 'catalog-or-actions-scale-limit-or-unimplemented-profile',
          })),
        );
        continue;
      }
      combinations += cost;
      catalog += bytes;
      lock += bytes;
      const intent = {
        repository: project.repository,
        package: first.package,
        profile: first.profile,
        versions: selected.map((r) => r.version).sort(),
      };
      // Stable across base changes so closed PRs are not reopened by a new base.
      batches.push({
        ...intent,
        id: sha256(canonical(intent)),
        baseSha,
        policyRevision: revision,
        draft: true,
        promotesDefault: false,
      });
    }
  }
  return {
    batches,
    queued,
    estimatedCombinations: combinations,
    publicationReady: false,
  };
}

export interface Snapshot {
  complete: boolean;
  baseSha: string;
  prs: {
    batchId: string;
    number: number;
    state: 'open' | 'closed';
    author: string;
    headSha: string;
    draft: boolean;
    checksSha?: string;
    checks?: 'pending' | 'success' | 'failure';
  }[];
  branches: Record<
    string,
    {
      headSha: string;
      preparedSha: string;
      baseSha: string;
      author: string;
      humanCommits: boolean;
    }
  >;
}
export function reconcile(
  batches: Batch[],
  snapshot: Snapshot,
  login: string,
  limit = 4,
) {
  requireThat(
    snapshot.complete && /^[\w-]+\[bot\]$/.test(login),
    'complete-snapshot-and-app-required',
  );
  gitSha(snapshot.baseSha);
  let open = snapshot.prs.filter(
    (p) => p.state === 'open' && p.author === login,
  ).length;
  return batches.map((batch) => {
    const prs = snapshot.prs.filter((p) => p.batchId === batch.id),
      branch = snapshot.branches[batch.id],
      [pr] = prs;
    let action: string;
    if (prs.some((p) => p.state === 'closed')) action = 'respect-closed';
    else if (prs.length > 1) action = 'conflict';
    else if (batch.baseSha !== snapshot.baseSha) action = 'replan';
    else if (
      branch &&
      (branch.humanCommits ||
        branch.author !== login ||
        branch.headSha !== branch.preparedSha ||
        branch.baseSha !== batch.baseSha)
    )
      action = 'preserve-human-work';
    else if (pr) {
      if (!branch || pr.author !== login || pr.headSha !== branch.headSha)
        action = 'preserve-human-work';
      else if (pr.checksSha === pr.headSha && pr.checks === 'success')
        action = 'ready-for-human-review';
      else if (pr.checksSha === pr.headSha && pr.checks) action = 'wait';
      else action = 'request-checks';
    } else if (open >= Math.min(4, limit)) action = 'queued';
    else {
      open++;
      action = branch ? 'recover-draft-pr' : 'prepare-isolated-branch';
    }
    return { batchId: batch.id, action };
  });
}
