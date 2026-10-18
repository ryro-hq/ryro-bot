import { parse } from 'smol-toml';
import {
  canonical,
  component,
  gitSha,
  requireThat,
  safePath,
  sha256,
} from './domain.js';
import type { Project } from './domain.js';

export function validateProject(project: Project): Project {
  requireThat(
    /^[\w-]+\/[\w.-]+$/.test(project.repository) &&
      project.policy === 'syrox-pkgs-v1',
    'invalid-project',
  );
  requireThat(
    project.fallback.length > 0 &&
      project.hosts.includes('debian') &&
      project.hosts.includes('ubuntu-24.04'),
    'incomplete-project',
  );
  const l = project.limits;
  requireThat(
    Number.isInteger(l.versionsPerBatch) &&
      l.versionsPerBatch >= 1 &&
      l.versionsPerBatch <= 5 &&
      Number.isInteger(l.openPrs) &&
      l.openPrs >= 1 &&
      l.openPrs <= 4,
    'invalid-budgets',
  );
  for (const value of [
    l.combinations,
    l.catalogBytes,
    l.lockBytes,
    l.estimatedBytesPerCombination,
    l.actionsMatrixRows,
  ])
    requireThat(
      Number.isSafeInteger(value) && value > 0,
      'invalid-scale-limit',
    );
  requireThat(
    l.actionsMatrixRows <= 256 && l.actionsMatrixRows >= project.hosts.length,
    'invalid-actions-matrix-budget',
  );
  const owners = [
    project.fallback,
    project.independentReviewers,
    ...Object.values(project.categories).flatMap((x) => [x.owners, x.deputies]),
    ...Object.values(project.packages).flatMap((x) => [x.owners, x.deputies]),
  ].flat();
  requireThat(
    owners.every((x) => /^@[a-z\d][a-z\d-]*$/i.test(x)),
    'individual-github-logins-required',
  );
  for (const [name, pkg] of Object.entries(project.packages)) {
    component(name);
    requireThat(
      project.categories[pkg.category] && pkg.profiles.length > 0,
      'invalid-package',
    );
    pkg.profiles.forEach(component);
  }
  for (const rule of [...Object.values(project.packages), ...project.shared]) {
    for (const pattern of rule.paths) {
      requireThat(
        /^[A-Za-z0-9_./*+-]+$/.test(pattern) &&
          !pattern.startsWith('/') &&
          !pattern.split('/').includes('..'),
        'unsafe-pattern',
      );
    }
  }
  for (const rule of project.shared)
    requireThat(
      rule.categories.every((c) => c in project.categories),
      'unknown-category',
    );
  return project;
}

export function admitBaseConfig(
  text: string,
  project: Project,
  revision: string,
) {
  requireThat(Buffer.byteLength(text) <= 8192, 'config-too-large');
  const config = parse(text);
  requireThat(
    Object.keys(config).sort().join(',') ===
      'enabled,policy,policy_revision,schema',
    'unknown-opt-in-fields',
  );
  requireThat(
    config.schema === 1 &&
      config.enabled === true &&
      config.policy === project.policy &&
      config.policy_revision === gitSha(revision),
    'base-policy-mismatch',
  );
  return sha256(text);
}

function matches(path: string, pattern: string): boolean {
  const expression = pattern
    .split('*')
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + expression + '$').test(path);
}

export function route(project: Project, paths: string[], author: string) {
  requireThat(
    paths.length > 0 && paths.length <= 3000,
    'incomplete-change-list',
  );
  const categories = new Set<string>(),
    packages = new Set<string>(),
    reviewers = new Set<string>();
  for (const path of paths) {
    safePath(path);
    let matched = false;
    for (const [name, pkg] of Object.entries(project.packages))
      if (pkg.paths.some((p) => matches(path, p))) {
        matched = true;
        packages.add(name);
        categories.add(pkg.category);
      }
    for (const rule of project.shared)
      if (rule.paths.some((p) => matches(path, p))) {
        matched = true;
        rule.categories.forEach((c) => categories.add(c));
        if (rule.affectsAll)
          Object.entries(project.packages).forEach(([name, pkg]) => {
            packages.add(name);
            categories.add(pkg.category);
          });
      }
    if (!matched) project.fallback.forEach((o) => reviewers.add(o));
  }
  for (const p of packages)
    [...project.packages[p].owners, ...project.packages[p].deputies].forEach(
      (o) => reviewers.add(o),
    );
  for (const c of categories)
    [
      ...project.categories[c].owners,
      ...project.categories[c].deputies,
    ].forEach((o) => reviewers.add(o));
  for (const reviewer of reviewers)
    if (reviewer.toLowerCase() === '@' + author.replace(/^@/, '').toLowerCase())
      reviewers.delete(reviewer);
  return {
    labels: [...categories].sort().map((c) => 'area:' + c),
    packages: [...packages].sort(),
    reviewers: [...reviewers].sort(),
    independentReviewerPending: reviewers.size === 0,
  };
}

export function ownershipArtifacts(project: Project) {
  // CODEOWNERS has last-match semantics. Conservatively union overlapping ownership;
  // exact review routing still uses the complete policy above.
  const all = [
    ...new Set([
      ...project.fallback,
      ...Object.values(project.categories).flatMap((c) => [
        ...c.owners,
        ...c.deputies,
      ]),
      ...Object.values(project.packages).flatMap((p) => [
        ...p.owners,
        ...p.deputies,
      ]),
    ]),
  ].sort();
  const patterns = [
    ...new Set(
      [...Object.values(project.packages), ...project.shared].flatMap(
        (r) => r.paths,
      ),
    ),
  ].sort();
  return {
    '.github/CODEOWNERS':
      '# Generated by ryro-bot from the pinned central registry.\n* ' +
      project.fallback.join(' ') +
      '\n' +
      patterns.map((p) => '/' + p + ' ' + all.join(' ')).join('\n') +
      '\n',
    '.github/labels.json':
      JSON.stringify(
        Object.keys(project.categories)
          .sort()
          .map((c) => ({
            name: 'area:' + c,
            color: '336699',
            description: 'Review routing: ' + c,
          })),
        null,
        2,
      ) + '\n',
  };
}
export const policyDigest = (project: Project) => sha256(canonical(project));
