import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

// gh supplies authentication, pagination and binary asset transfer. Never invoke a shell.
export interface Api {
  get<T>(path: string): T;
  pages<T>(path: string): T[];
  patch(path: string, body: unknown): void;
  asset<T>(id: number): T;
  upload(releaseId: number, name: string, content: string): void;
}

export const repository = 'ryro-hq/ryro-bot';
export const image = `ghcr.io/${repository}`;

export function githubApi(token = process.env.GH_TOKEN): Api {
  function gh(args: string[], input?: string): string {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      ...(input === undefined ? {} : { input }),
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
    });
  }
  const path = (suffix: string) => `repos/${repository}/${suffix}`;
  return {
    get: <T>(suffix: string): T => JSON.parse(gh(['api', path(suffix)])),
    pages: <T>(suffix: string): T[] =>
      (
        JSON.parse(gh(['api', '--paginate', '--slurp', path(suffix)])) as T[][]
      ).flat(),
    patch: (suffix, body) => {
      gh(
        ['api', '--method', 'PATCH', path(suffix), '--input', '-'],
        JSON.stringify(body),
      );
    },
    asset: <T>(id: number): T =>
      JSON.parse(
        gh([
          'api',
          path(`releases/assets/${id}`),
          '-H',
          'Accept: application/octet-stream',
        ]),
      ),
    upload: (id, name, content) => {
      gh(
        [
          'api',
          '--method',
          'POST',
          `https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
          '-H',
          'Content-Type: application/json',
          '--input',
          '-',
        ],
        content,
      );
    },
  };
}

export function requireRelease(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export interface Asset {
  id: number;
  name: string;
}
export interface Release {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  body: string | null;
}
export interface Candidate {
  version: string;
  sha: string;
  digest: string;
  image: string;
  buildRun: string;
}
export interface Qualified extends Candidate {
  ciRun: string;
  qualificationRun: string;
  platform: 'linux/amd64';
  platformDigest: string;
  checks: { cli: true; migrations: true; health: true };
}
interface Run {
  id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string;
  path: string;
  repository: { full_name: string };
}

export function validateTag(tag: string): string {
  requireRelease(
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag),
    'Expected stable tag vX.Y.Z',
  );
  return tag.slice(1);
}

export function assets(api: Api, release: Release): Asset[] {
  return api.pages<Asset>(`releases/${release.id}/assets?per_page=100`);
}

export function findRelease(api: Api, tag: string): Release {
  validateTag(tag);
  const release = api
    .pages<Release>('releases?per_page=100')
    .find((r) => r.tag_name === tag);
  requireRelease(release, `Existing release required for ${tag}`);
  requireRelease(
    release.draft,
    `${tag} is already published; it cannot be overwritten`,
  );
  return release;
}

export function source(api: Api, release: Release) {
  const version = validateTag(release.tag_name);
  requireRelease(release.draft, 'Release must remain a draft');
  const sha = release.target_commitish;
  requireRelease(
    /^[a-f0-9]{40}$/.test(sha),
    'Release target must be a full commit SHA',
  );
  const tag = api.get<{ object: { type: string; sha: string } }>(
    `git/ref/tags/${release.tag_name}`,
  );
  // Release Please creates lightweight tags; fail closed for unexpected tag types.
  requireRelease(
    tag.object.type === 'commit' && tag.object.sha === sha,
    'Tag and release SHA differ',
  );
  const comparison = api.get<{ status: string }>(`compare/${sha}...main`);
  requireRelease(
    ['ahead', 'identical'].includes(comparison.status),
    'Release SHA is not on main',
  );
  for (const filename of [
    'package.json',
    'package-lock.json',
    '.release-please-manifest.json',
  ]) {
    const file = api.get<{ content: string }>(
      `contents/${filename}?ref=${sha}`,
    );
    const value = JSON.parse(
      Buffer.from(file.content, 'base64').toString(),
    ) as {
      version?: string;
      packages?: Record<string, { version: string }>;
      '.'?: string;
    };
    requireRelease(
      filename === '.release-please-manifest.json'
        ? value['.'] === version
        : value.version === version &&
            (filename !== 'package-lock.json' ||
              value.packages?.['']?.version === version),
      `Version mismatch in ${filename}`,
    );
  }
  const runs = api.pages<{ workflow_runs: Run[] }>(
    `actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`,
  );
  const flattened = runs.flatMap((page) => page.workflow_runs);
  const ci = flattened.find(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === 'main' &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.path === '.github/workflows/ci.yml' &&
      run.repository.full_name === repository,
  );
  requireRelease(ci, 'No successful main push CI for the exact release SHA');
  return {
    version,
    sha,
    ciRun: `https://github.com/${repository}/actions/runs/${ci.id}`,
  };
}

export function validateCandidate(
  candidate: Candidate,
  expected: { version: string; sha: string },
) {
  requireRelease(
    candidate.version === expected.version &&
      candidate.sha === expected.sha &&
      candidate.image === image &&
      /^sha256:[a-f0-9]{64}$/.test(candidate.digest) &&
      new RegExp(
        `^https://github.com/${repository}/actions/runs/[1-9]\\d*$`,
      ).test(candidate.buildRun),
    'Invalid or conflicting candidate metadata',
  );
}

export function readCandidate(
  api: Api,
  release: Release,
): Candidate | undefined {
  const asset = assets(api, release).find(
    (entry) => entry.name === 'candidate.json',
  );
  if (!asset) return undefined;
  const candidate = api.asset<Candidate>(asset.id);
  validateCandidate(candidate, {
    version: validateTag(release.tag_name),
    sha: release.target_commitish,
  });
  return candidate;
}

export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export const checksum = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export function validateEvidence(
  candidate: Candidate,
  metadata: Qualified,
  sbom: unknown,
  provenance: unknown,
) {
  validateCandidate(metadata, candidate);
  requireRelease(
    metadata.digest === candidate.digest &&
      metadata.buildRun === candidate.buildRun &&
      metadata.platform === 'linux/amd64' &&
      metadata.checks?.cli === true &&
      metadata.checks?.migrations === true &&
      metadata.checks?.health === true,
    'Missing image qualification evidence',
  );
  const inventory = sbom as { spdxVersion?: string; packages?: unknown[] };
  const attestation = provenance as {
    subject?: { digest?: { sha256?: string } }[];
    predicateType?: string;
    predicate?: unknown;
  };
  requireRelease(
    inventory?.spdxVersion?.startsWith('SPDX-') &&
      Array.isArray(inventory.packages) &&
      inventory.packages.length > 0,
    'Missing SPDX SBOM',
  );
  requireRelease(
    attestation?.predicateType?.startsWith('https://slsa.dev/provenance/') &&
      attestation.predicate &&
      /^sha256:[a-f0-9]{64}$/.test(metadata.platformDigest) &&
      attestation.subject?.some(
        (subject) =>
          subject.digest?.sha256 === metadata.platformDigest.slice(7),
      ),
    'Missing SLSA provenance',
  );
}

// Immutable assets let interrupted publications resume without replacing earlier evidence.
export function putAsset(
  api: Api,
  release: Release,
  name: string,
  value: unknown,
) {
  const existing = assets(api, release).find((entry) => entry.name === name);
  if (existing) {
    requireRelease(
      json(api.asset(existing.id)) === json(value),
      `Conflicting existing ${name}`,
    );
  } else api.upload(release.id, name, json(value));
}

export function publicationEvidence(api: Api, release: Release) {
  const candidate = readCandidate(api, release);
  requireRelease(candidate, 'Missing candidate');
  const entries = assets(api, release);
  function evidence<T>(name: string): T {
    const asset = entries.find((entry) => entry.name === name);
    requireRelease(asset, `Missing release asset ${name}`);
    return api.asset<T>(asset.id);
  }
  validateEvidence(
    candidate,
    evidence('release.json'),
    evidence('sbom.spdx.json'),
    evidence('provenance.json'),
  );
  const checksums = evidence<Record<string, string>>('checksums.json');
  for (const name of [
    'candidate.json',
    'release.json',
    'sbom.spdx.json',
    'provenance.json',
  ]) {
    requireRelease(
      checksums[name] === checksum(json(evidence(name))),
      `Checksum mismatch for ${name}`,
    );
  }
  return candidate;
}

export function publishRelease(
  api: Api,
  readApi: Api,
  release: Release,
  verifyPublicImage: (candidate: Candidate) => void,
) {
  source(readApi, release);
  const candidate = publicationEvidence(api, release);
  verifyPublicImage(candidate);
  const details = `\n\nImage: \`${image}:${candidate.version}\`\nDigest: \`${candidate.digest}\`\nCommit: ${candidate.sha}\nEvidence: attached SBOM, provenance, checksums and release metadata.\n`;
  api.patch(`releases/${release.id}`, {
    draft: false,
    body: (release.body ?? '') + details,
  });
}

async function main() {
  const api = githubApi();
  const readApi = githubApi(process.env.GITHUB_TOKEN);
  const command = process.argv[2];
  const run = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const output = (name: string, value: string | number) => {
    requireRelease(
      process.env.GITHUB_OUTPUT && !String(value).includes('\n'),
      'Invalid workflow output',
    );
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  };
  const load = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8'));
  const selected = () => findRelease(api, process.env.RELEASE_TAG ?? '');

  if (command === 'select') {
    let tag = process.env.RELEASE_TAG;
    if (!tag) {
      const release = api
        .pages<Release>('releases?per_page=100')
        .find(
          (entry) =>
            entry.draft && entry.target_commitish === process.env.CI_SHA,
        );
      tag = release?.tag_name;
    }
    if (tag) {
      const release = findRelease(api, tag);
      const verified = source(readApi, release);
      const candidate = readCandidate(api, release);
      output('tag', tag);
      output('version', verified.version);
      output('sha', verified.sha);
      output('ci_run', verified.ciRun);
      output('digest', candidate?.digest ?? '');
      const qualified = assets(api, release).some(
        (asset) => asset.name === 'checksums.json',
      );
      if (qualified) publicationEvidence(api, release);
      output('qualified', String(qualified));
    }
  } else if (command === 'record') {
    const release = selected();
    const verified = source(readApi, release);
    const candidate: Candidate = {
      version: verified.version,
      sha: verified.sha,
      image,
      digest: process.env.CANDIDATE_DIGEST ?? '',
      buildRun: run,
    };
    const existing = readCandidate(api, release);
    if (existing)
      requireRelease(
        existing.digest === candidate.digest,
        'Candidate digest cannot change on retry',
      );
    else {
      // Validation also happens when the candidate is read back below.
      validateCandidate(candidate, verified);
      putAsset(api, release, 'candidate.json', candidate);
    }
    requireRelease(readCandidate(api, release), 'Candidate was not persisted');
  } else if (command === 'evidence') {
    const release = selected();
    const verified = source(readApi, release);
    const candidate = readCandidate(api, release);
    requireRelease(candidate, 'Missing persisted candidate');
    requireRelease(
      load<{ cli: boolean; migrations: boolean; health: boolean }>(
        'evidence/smoke.json',
      ).health,
      'Smoke test did not finish',
    );
    const metadata: Qualified = {
      ...candidate,
      ciRun: verified.ciRun,
      qualificationRun: run,
      platform: 'linux/amd64',
      platformDigest: process.env.PLATFORM_DIGEST ?? '',
      checks: load<Qualified['checks']>('evidence/smoke.json'),
    };
    const sbom = load<unknown>('evidence/sbom.spdx.json');
    const provenance = load<unknown>('evidence/provenance.json');
    validateEvidence(candidate, metadata, sbom, provenance);
    // Preserve the first successful qualification run when resuming publication.
    const old = assets(api, release).find(
      (asset) => asset.name === 'release.json',
    );
    const stable = old ? api.asset<Qualified>(old.id) : metadata;
    validateEvidence(candidate, stable, sbom, provenance);
    requireRelease(
      stable.platformDigest === metadata.platformDigest,
      'Platform digest changed',
    );
    const files = {
      'sbom.spdx.json': sbom,
      'provenance.json': provenance,
      'release.json': stable,
    };
    for (const [name, value] of Object.entries(files))
      putAsset(api, release, name, value);
    putAsset(
      api,
      release,
      'checksums.json',
      Object.fromEntries(
        Object.entries({ 'candidate.json': candidate, ...files }).map(
          ([name, value]) => [name, checksum(json(value))],
        ),
      ),
    );
  } else if (command === 'publish') {
    const release = selected();
    publishRelease(api, readApi, release, (candidate) => {
      requireRelease(
        process.env.PUBLIC_DIGEST === candidate.digest,
        'Missing anonymous pull verification for the validated digest',
      );
    });
  } else throw new Error(`Unknown release command: ${command}`);
}

if (import.meta.main) await main();
