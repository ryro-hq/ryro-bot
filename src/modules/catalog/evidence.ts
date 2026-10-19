import { createHash } from 'node:crypto';
import { Unzip, UnzipInflate } from 'fflate';
import { parse } from 'smol-toml';
import { canonical, gitSha, safePath, sha256 } from '../../kernel/values.js';
import { requireThat } from '../../kernel/errors.js';
import type { Batch } from './model.js';
import type { Project } from '../contracts/project.js';
import type { Run } from '../ci/model.js';

export interface Prepared {
  schema: 1;
  batchId: string;
  repositoryId: number;
  baseSha: string;
  policyRevision: string;
  runId: number;
  runAttempt: number;
  defaultsBefore: unknown;
  files: {
    path: string;
    beforeBlob: string | null;
    content: string;
    sha256: string;
  }[];
}
export const blobSha = (bytes: Buffer) =>
  createHash('sha1')
    .update('blob ' + bytes.length + '\0')
    .update(bytes)
    .digest('hex');

export function unzipPrepared(bytes: Uint8Array): Buffer {
  const chunks: Uint8Array[] = [];
  let total = 0,
    entries = 0,
    ended = false;
  const unzip = new Unzip((file) => {
    entries++;
    requireThat(
      entries === 1 &&
        file.name === 'prepared.json' &&
        (file.originalSize === undefined ||
          file.originalSize <= 8 * 1024 * 1024),
      'unexpected-artifact-entry',
    );
    file.ondata = (error, chunk, final) => {
      requireThat(!error, 'invalid-artifact-zip');
      total += chunk.length;
      requireThat(total <= 8 * 1024 * 1024, 'artifact-expansion-limit');
      chunks.push(chunk);
      ended = final;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 4096)
    unzip.push(
      bytes.subarray(offset, offset + 4096),
      offset + 4096 >= bytes.length,
    );
  requireThat(entries === 1 && ended, 'incomplete-artifact-zip');
  return Buffer.concat(chunks);
}

export function admitPrepared(
  doc: Prepared,
  batch: Batch,
  run: Run,
  repositoryId: number,
  project: Project,
) {
  requireThat(
    doc.schema === 1 &&
      doc.batchId === batch.id &&
      doc.repositoryId === repositoryId &&
      doc.baseSha === batch.baseSha &&
      doc.policyRevision === batch.policyRevision &&
      doc.runId === run.id &&
      doc.runAttempt === (run.run_attempt ?? 1),
    'prepared-context-mismatch',
  );
  gitSha(doc.baseSha);
  gitSha(doc.policyRevision);
  requireThat(
    run.repository.id === repositoryId &&
      run.head_repository.id === repositoryId &&
      run.head_sha === batch.baseSha &&
      run.event === 'workflow_dispatch' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.path === '.github/workflows/' + project.preparationWorkflow,
    'untrusted-preparation-run',
  );
  requireThat(
    run.referenced_workflows?.some(
      (w) =>
        w.path ===
          'ryro-hq/ryro-bot/.github/workflows/prepare.yml@' +
            batch.policyRevision && w.sha === batch.policyRevision,
    ),
    'unpinned-preparation-workflow',
  );
  requireThat(
    Array.isArray(doc.files) &&
      doc.files.length >= 1 &&
      doc.files.length <= 100,
    'invalid-prepared-file-count',
  );
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of doc.files) {
    safePath(file.path);
    requireThat(!paths.has(file.path), 'duplicate-prepared-path');
    paths.add(file.path);
    requireThat(
      ['catalog.toml', 'Catalog.lock', 'Syrox.lock'].includes(file.path) ||
        file.path.startsWith('recipes/packages/' + batch.package + '/') ||
        file.path.startsWith('changes/'),
      'prepared-path-outside-package',
    );
    requireThat(
      file.beforeBlob === null || /^[0-9a-f]{40}$/.test(file.beforeBlob),
      'invalid-before-blob',
    );
    requireThat(
      typeof file.content === 'string' &&
        file.content.length <= 6 * 1024 * 1024,
      'invalid-file-encoding',
    );
    const content = Buffer.from(file.content, 'base64');
    bytes += content.length;
    requireThat(
      content.toString('base64') === file.content &&
        sha256(content) === file.sha256 &&
        bytes <= 6 * 1024 * 1024,
      'prepared-file-integrity',
    );
  }
  requireThat(
    paths.has('catalog.toml') &&
      paths.has('Catalog.lock') &&
      paths.has('Syrox.lock'),
    'missing-prepared-locks',
  );
  return doc;
}

export function verifyCatalogAddition(
  beforeBytes: Buffer,
  afterBytes: Buffer,
  batch: Batch,
  project: Project,
) {
  requireThat(
    afterBytes.length <= project.limits.catalogBytes,
    'catalog-byte-limit',
  );
  type Catalog = {
    schema: number;
    releases: {
      name: string;
      version: string;
      combinations: { variant: string }[];
    }[];
    [key: string]: unknown;
  };
  const before = parse(beforeBytes.toString('utf8')) as unknown as Catalog,
    after = parse(afterBytes.toString('utf8')) as unknown as Catalog;
  requireThat(
    before.schema === 2 && after.schema === 2,
    'unsupported-catalog-schema',
  );
  const { releases: oldReleases, ...oldHeader } = before,
    { releases: newReleases, ...newHeader } = after;
  requireThat(
    canonical(oldHeader) === canonical(newHeader) &&
      Array.isArray(oldReleases) &&
      Array.isArray(newReleases),
    'defaults-or-channels-changed',
  );
  const old = new Map(
    oldReleases.map((r) => [canonical([r.name, r.version]), canonical(r)]),
  );
  const additions = new Map<string, unknown>();
  let combinations = 0;
  for (const row of newReleases) {
    requireThat(
      row && typeof row === 'object' && !Array.isArray(row),
      'invalid-catalog-release',
    );
    const key = canonical([row.name, row.version]);
    requireThat(!additions.has(key), 'duplicate-catalog-release');
    additions.set(key, row);
    requireThat(
      Array.isArray(row.combinations),
      'invalid-catalog-combinations',
    );
    combinations += row.combinations.length;
    if (old.has(key))
      requireThat(old.get(key) === canonical(row), 'existing-release-changed');
    else
      requireThat(
        row.name === batch.package &&
          typeof row.version === 'string' &&
          batch.versions.includes(row.version) &&
          row.combinations.every(
            (c) =>
              c !== null &&
              typeof c === 'object' &&
              !Array.isArray(c) &&
              c.variant === batch.profile,
          ),
        'unexpected-release-addition',
      );
  }
  requireThat(
    [...old.keys()].every((k) => additions.has(k)) &&
      newReleases.length === oldReleases.length + batch.versions.length &&
      combinations <= project.limits.combinations,
    'missing-or-excess-release-additions',
  );
}

export interface PublicationEvidence {
  schema: 1;
  artifactSha256: string;
  baseSha: string;
  headSha: string;
  policyRevision: string;
  sbom: { artifactSha256: string; digest: string };
  sources: { artifactSha256: string; digest: string };
  patches: { artifactSha256: string; digest: string };
  licenses: { artifactSha256: string; digest: string };
  provenance: { artifactSha256: string; digest: string };
  qualifications: {
    host: string;
    system: string;
    artifactSha256: string;
    environmentDigest: string;
    passed: boolean;
  }[];
}
export function publicationReady(
  e: PublicationEvidence,
  expected: {
    artifactSha256: string;
    headSha: string;
    baseSha: string;
    policyRevision: string;
    environments: Record<string, string>;
  },
  project: Project,
) {
  requireThat(
    e.schema === 1 &&
      /^[0-9a-f]{64}$/.test(e.artifactSha256) &&
      e.artifactSha256 === expected.artifactSha256 &&
      e.baseSha === expected.baseSha &&
      e.headSha === expected.headSha &&
      e.policyRevision === expected.policyRevision,
    'publication-context-mismatch',
  );
  for (const entry of [e.sbom, e.sources, e.patches, e.licenses, e.provenance])
    requireThat(
      entry &&
        entry.artifactSha256 === expected.artifactSha256 &&
        /^[0-9a-f]{64}$/.test(entry.digest),
      'incomplete-publication-evidence',
    );
  for (const host of project.hosts)
    for (const system of ['linux-x86_64-gnu', 'linux-x86_64-musl']) {
      const rows = e.qualifications.filter(
        (q) => q.host === host && q.system === system,
      );
      requireThat(
        rows.length === 1 &&
          rows[0].passed &&
          rows[0].artifactSha256 === expected.artifactSha256 &&
          /^[0-9a-f]{64}$/.test(expected.environments[host] ?? '') &&
          rows[0].environmentDigest === expected.environments[host],
        'missing-or-wrong-environment-qualification',
      );
    }
  return true;
}
