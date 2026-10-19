import { describe, expect, it } from 'vitest';
import type { Api } from '../../.github/scripts/release.ts';
import { image, repository } from '../../.github/scripts/release.ts';
import {
  checksum,
  findRelease,
  json,
  publishRelease,
  putAsset,
  readCandidate,
  source,
  validateEvidence,
  validateTag,
} from '../../.github/scripts/release.ts';
import type {
  Candidate,
  Qualified,
  Release,
} from '../../.github/scripts/release.ts';

const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const platformDigest = `sha256:${'c'.repeat(64)}`;
const run = `https://github.com/${repository}/actions/runs/123`;
const candidate: Candidate = {
  version: '0.1.0',
  sha,
  digest,
  image,
  buildRun: run,
};
const metadata: Qualified = {
  ...candidate,
  ciRun: run,
  qualificationRun: run,
  platform: 'linux/amd64',
  platformDigest,
  checks: { cli: true, migrations: true, health: true },
};
const sbom = { spdxVersion: 'SPDX-2.3', packages: [{ name: 'node' }] };
const provenance = {
  predicateType: 'https://slsa.dev/provenance/v0.2',
  predicate: { buildType: 'https://mobyproject.org/buildkit@v1' },
  subject: [{ digest: { sha256: platformDigest.slice(7) } }],
};

function fixture() {
  const release: Release = {
    id: 1,
    tag_name: 'v0.1.0',
    target_commitish: sha,
    draft: true,
    body: 'Release notes',
  };
  const data = new Map<string, unknown>();
  const uploaded = new Map<number, { name: string; value: unknown }>();
  const mutations: { path: string; body: unknown }[] = [];
  data.set('releases?per_page=100', [release]);
  data.set(`git/ref/tags/${release.tag_name}`, {
    object: { type: 'commit', sha },
  });
  data.set(`compare/${sha}...main`, { status: 'ahead' });
  for (const [file, value] of Object.entries({
    'package.json': { version: '0.1.0' },
    'package-lock.json': {
      version: '0.1.0',
      packages: { '': { version: '0.1.0' } },
    },
    '.release-please-manifest.json': { '.': '0.1.0' },
  })) {
    data.set(`contents/${file}?ref=${sha}`, {
      content: Buffer.from(json(value)).toString('base64'),
    });
  }
  const ciPath = `actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`;
  const ci = {
    id: 123,
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/ci.yml',
    repository: { full_name: repository },
  };
  data.set(ciPath, [{ workflow_runs: [ci] }]);
  function get<T>(path: string): T {
    if (!data.has(path)) throw new Error(`Unexpected API request: ${path}`);
    return data.get(path) as T;
  }
  const api: Api = {
    get,
    pages: <T>(path: string): T[] =>
      path === 'releases/1/assets?per_page=100'
        ? Array.from(uploaded, ([id, asset]) => ({ id, name: asset.name }) as T)
        : get<T[]>(path),
    patch: (path, body) => {
      mutations.push({ path, body });
    },
    asset: <T>(id: number): T => uploaded.get(id)?.value as T,
    upload: (_id, name, content) => {
      uploaded.set(uploaded.size + 1, { name, value: JSON.parse(content) });
    },
  };
  function evidence() {
    const files = {
      'candidate.json': candidate,
      'release.json': metadata,
      'sbom.spdx.json': sbom,
      'provenance.json': provenance,
    };
    for (const [name, value] of Object.entries(files))
      putAsset(api, release, name, value);
    putAsset(
      api,
      release,
      'checksums.json',
      Object.fromEntries(
        Object.entries(files).map(([name, value]) => [
          name,
          checksum(json(value)),
        ]),
      ),
    );
  }
  return { api, release, data, mutations, uploaded, ci, ciPath, evidence };
}

describe('release source gates', () => {
  it('requires matching stable versions, a fixed tag and exact successful main push CI', () => {
    const f = fixture();
    expect(source(f.api, f.release)).toEqual({
      version: '0.1.0',
      sha,
      ciRun: run,
    });
    expect(() => validateTag('v01.0.0')).toThrow();
    expect(() => validateTag('v1.0.0;echo unsafe')).toThrow();
    f.data.set(`git/ref/tags/v0.1.0`, {
      object: { type: 'commit', sha: 'd'.repeat(40) },
    });
    expect(() => source(f.api, f.release)).toThrow(
      'Tag and release SHA differ',
    );
  });
  it.each([
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { status: 'in_progress' },
    { head_sha: 'd'.repeat(40) },
    { event: 'pull_request' },
    { event: 'merge_group' },
    { head_branch: 'feature' },
    { path: '.github/workflows/other.yml' },
    { repository: { full_name: 'fork/ryro-bot' } },
  ])('rejects unqualified CI: %j', (override) => {
    const f = fixture();
    f.data.set(f.ciPath, [{ workflow_runs: [{ ...f.ci, ...override }] }]);
    expect(() => source(f.api, f.release)).toThrow(
      'No successful main push CI',
    );
  });
  it('rejects absent CI, branches outside main, and mismatched version files', () => {
    const f = fixture();
    f.data.set(f.ciPath, [{ workflow_runs: [] }]);
    expect(() => source(f.api, f.release)).toThrow('No successful');
    f.data.set(`compare/${sha}...main`, { status: 'diverged' });
    expect(() => source(f.api, f.release)).toThrow('not on main');
    f.data.set(`compare/${sha}...main`, { status: 'identical' });
    f.data.set(`contents/package.json?ref=${sha}`, {
      content: Buffer.from('{"version":"0.2.0"}').toString('base64'),
    });
    expect(() => source(f.api, f.release)).toThrow('Version mismatch');
  });
  it('refuses to resume a published release', () => {
    const f = fixture();
    f.release.draft = false;
    expect(() => findRelease(f.api, 'v0.1.0')).toThrow('already published');
  });
});

describe('release evidence and recovery', () => {
  it('reuses a persisted digest and refuses to overwrite candidate evidence', () => {
    const f = fixture();
    putAsset(f.api, f.release, 'candidate.json', candidate);
    expect(readCandidate(f.api, f.release)).toEqual(candidate);
    putAsset(f.api, f.release, 'candidate.json', candidate);
    expect(f.uploaded.size).toBe(1);
    expect(() =>
      putAsset(f.api, f.release, 'candidate.json', {
        ...candidate,
        digest: platformDigest,
      }),
    ).toThrow('Conflicting existing');
  });
  it('requires successful migrations, health, CLI and attestations tied to the platform digest', () => {
    expect(() =>
      validateEvidence(candidate, metadata, sbom, provenance),
    ).not.toThrow();
    expect(() =>
      validateEvidence(
        candidate,
        {
          ...metadata,
          checks: { ...metadata.checks, migrations: false },
        } as unknown as Qualified,
        sbom,
        provenance,
      ),
    ).toThrow('qualification');
    expect(() =>
      validateEvidence(candidate, metadata, null, provenance),
    ).toThrow('SPDX');
    expect(() => validateEvidence(candidate, metadata, sbom, null)).toThrow(
      'SLSA',
    );
    expect(() =>
      validateEvidence(
        candidate,
        { ...metadata, platformDigest: digest },
        sbom,
        provenance,
      ),
    ).toThrow('SLSA');
  });
  it('requires every evidence file and its checksum before publishing', () => {
    const f = fixture();
    putAsset(f.api, f.release, 'candidate.json', candidate);
    expect(() => publishRelease(f.api, f.api, f.release, () => {})).toThrow(
      'Missing release asset',
    );
    expect(f.mutations).toEqual([]);
    f.evidence();
    const item = [...f.uploaded.values()].find(
      (asset) => asset.name === 'checksums.json',
    );
    if (item) item.value = {};
    expect(() => publishRelease(f.api, f.api, f.release, () => {})).toThrow(
      'Checksum mismatch',
    );
    expect(f.mutations).toEqual([]);
  });
  it('resumes after failed publication with the original candidate and evidence', () => {
    const f = fixture();
    f.evidence();
    expect(() =>
      publishRelease(f.api, f.api, f.release, () => {
        throw new Error('Package still private');
      }),
    ).toThrow('Package still private');
    expect(f.mutations).toEqual([]);
    expect(readCandidate(f.api, f.release)?.digest).toBe(digest);
    let checked = '';
    publishRelease(f.api, f.api, f.release, (value) => {
      checked = value.digest;
    });
    expect(checked).toBe(digest);
    expect(f.mutations).toEqual([
      {
        path: 'releases/1',
        body: { draft: false, body: expect.stringContaining(digest) },
      },
    ]);
    expect(f.uploaded.size).toBe(5);
  });
});
