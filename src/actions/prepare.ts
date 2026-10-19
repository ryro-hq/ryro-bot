import { execFileSync } from 'node:child_process';
import {
  constants,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import {
  canonical,
  component,
  gitSha,
  safePath,
  sha256,
} from '../kernel/values.js';
import { requireThat } from '../kernel/errors.js';
import type { Batch } from '../modules/catalog/model.js';
import type { Prepared } from '../modules/catalog/evidence.js';
import { verifyCatalogAddition } from '../modules/catalog/evidence.js';
import { admitBaseConfig } from '../kernel/policy.js';
import { decodeProjects } from '../app/config/registry.js';

// This entry point runs in the read-only Actions job, never in the App service.
export function prepare(
  root: string,
  output: string,
  cli: string,
  env = process.env,
): Prepared {
  const versions: unknown = JSON.parse(env.VERSIONS ?? 'null');
  requireThat(
    Array.isArray(versions) &&
      versions.length >= 1 &&
      versions.length <= 5 &&
      new Set(versions).size === versions.length,
    'invalid-preparation-versions',
  );
  versions.forEach(component);
  const intent = {
    repository: env.GITHUB_REPOSITORY ?? '',
    package: component(env.PACKAGE ?? ''),
    profile: component(env.PROFILE ?? ''),
    versions: [...versions].sort() as string[],
  };
  const projects = decodeProjects(
    JSON.parse(
      readFileSync(
        new URL('../../registry/projects.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const repositoryId = Number(env.GITHUB_REPOSITORY_ID);
  const project = projects.find(
    (p) =>
      [p.repository, p.canonicalRepository, ...(p.aliases ?? [])].includes(
        intent.repository,
      ) &&
      (!p.repositoryId || p.repositoryId === repositoryId),
  );
  requireThat(project, 'unregistered-preparation-project');
  // Renames do not change previously persisted logical batches.
  const logical = [
    ...new Set([
      project.repository,
      project.canonicalRepository,
      ...(project.aliases ?? []),
    ]),
  ]
    .filter((name): name is string => Boolean(name))
    .map((repository) => ({ ...intent, repository }))
    .find((value) => sha256(canonical(value)) === env.BATCH_ID);
  requireThat(logical, 'preparation-batch-mismatch');
  const batch: Batch = {
    ...logical,
    id: sha256(canonical(logical)),
    baseSha: gitSha(env.EXPECTED_SHA ?? ''),
    policyRevision: gitSha(env.POLICY_REVISION ?? ''),
    draft: true,
    promotesDefault: false,
  };
  requireThat(
    project.packages[batch.package]?.profiles.includes(batch.profile),
    'unregistered-preparation-profile',
  );
  const runId = Number(env.GITHUB_RUN_ID),
    runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  requireThat(
    [repositoryId, runId, runAttempt].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ),
    'invalid-preparation-run',
  );
  const cwd = realpathSync(root),
    engine = resolve(cli);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  requireThat(
    git('rev-parse', 'HEAD') === batch.baseSha &&
      git('status', '--porcelain', '--untracked-files=no') === '',
    'preparation-base-mismatch',
  );
  admitBaseConfig(
    readFileSync(resolve(cwd, '.ryro-bot.toml'), 'utf8'),
    project,
    batch.policyRevision,
  );
  const before = readFileSync(resolve(cwd, 'catalog.toml'));
  for (const version of batch.versions)
    execFileSync(engine, ['catalog', 'add', cwd, batch.package, version], {
      cwd,
      stdio: 'inherit',
    });
  verifyCatalogAddition(
    before,
    readFileSync(resolve(cwd, 'catalog.toml')),
    batch,
    project,
  );
  for (const [command, ...args] of [
    ['generate', '--check'],
    ['check'],
    ['lock', '--check'],
  ]) {
    execFileSync(engine, ['catalog', command, cwd, ...args], {
      cwd,
      stdio: 'inherit',
    });
  }
  const paths = new Set(
    [
      ...git('diff', '--name-only', batch.baseSha).split('\n'),
      ...git(
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        'recipes',
        'changes',
      ).split('\n'),
    ].filter(Boolean),
  );
  requireThat(
    paths.size >= 1 &&
      paths.size <= 100 &&
      ['catalog.toml', 'Catalog.lock', 'Syrox.lock'].every((path) =>
        paths.has(path),
      ),
    'invalid-preparation-files',
  );
  let total = 0;
  const files = [...paths].sort().map((path) => {
    safePath(path);
    requireThat(
      ['catalog.toml', 'Catalog.lock', 'Syrox.lock'].includes(path) ||
        path.startsWith(`recipes/packages/${batch.package}/`) ||
        path.startsWith('changes/'),
      'prepared-path-outside-package',
    );
    const location = resolve(cwd, path),
      metadata = lstatSync(location);
    requireThat(
      metadata.isFile() &&
        metadata.size <= 4 * 1024 * 1024 &&
        realpathSync(location) === location,
      'invalid-prepared-file',
    );
    const fd = openSync(
      location,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    total += bytes.length;
    requireThat(
      bytes.length <= 4 * 1024 * 1024 && total <= 6 * 1024 * 1024,
      'preparation-size-limit',
    );
    const entries = git('ls-tree', batch.baseSha, '--', path);
    const beforeBlob = entries ? entries.split(/\s+/)[2] : null;
    return {
      path,
      beforeBlob,
      content: bytes.toString('base64'),
      sha256: sha256(bytes),
    };
  });
  const document: Prepared = {
    schema: 1,
    batchId: batch.id,
    repositoryId,
    baseSha: batch.baseSha,
    policyRevision: batch.policyRevision,
    runId,
    runAttempt,
    defaultsBefore: parse(before.toString('utf8')).defaults,
    files,
  };
  writeFileSync(resolve(output), JSON.stringify(document) + '\n', {
    flag: 'wx',
  });
  return document;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const [root, output, cli] = process.argv.slice(2);
  requireThat(root && output && cli, 'usage-prepare-root-output-cli');
  prepare(root, output, cli);
}
