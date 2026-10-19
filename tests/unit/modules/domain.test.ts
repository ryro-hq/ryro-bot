import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Redacted } from 'effect';
import { zipSync, strToU8 } from 'fflate';
import { canonical, sha256 } from '../../../src/kernel/values.js';
import type { Batch, Candidate } from '../../../src/modules/catalog/model.js';
import type { Project } from '../../../src/modules/contracts/project.js';
import { admitBaseConfig } from '../../../src/kernel/policy.js';
import {
  ownershipArtifacts,
  route,
} from '../../../src/modules/reviews/policy.js';
import { validateProject } from '../../../src/app/config/registry.js';
import { plan, reconcile } from '../../../src/modules/catalog/planner.js';
import type { Snapshot } from '../../../src/modules/catalog/planner.js';
import {
  admitWebhook,
  verifySignature,
} from '../../../src/adapters/http/webhooks.js';
import { parsePage } from '../../../src/modules/catalog/discovery.js';
import { sameOrigin } from '../../../src/kernel/urls.js';
import {
  admitPrepared,
  publicationReady,
  unzipPrepared,
  verifyCatalogAddition,
} from '../../../src/modules/catalog/evidence.js';
import type {
  Prepared,
  PublicationEvidence,
} from '../../../src/modules/catalog/evidence.js';
import type { Run } from '../../../src/adapters/github/client.js';

export const project: Project = validateProject(
  JSON.parse(
    readFileSync(
      new URL('../../../registry/projects.json', import.meta.url),
      'utf8',
    ),
  ).projects[0],
);
const base = 'a'.repeat(40),
  revision = 'b'.repeat(40);
const candidate = (version: string, securityFix = false): Candidate => ({
  package: 'nginx',
  version,
  profile: 'minimal',
  state: 'discovered',
  securityFix,
});
const admitted = [
  {
    package: 'nginx',
    version: '1.0.0',
    profile: 'minimal',
    systems: ['linux-x86_64-gnu', 'linux-x86_64-musl'],
  },
];
const makePlan = (candidates = [candidate('2.0.0')], p = project) =>
  plan(p, base, revision, candidates, admitted, { catalog: 100, lock: 100 });
const batch = () => makePlan().batches[0];

describe('base policy and review routing', () => {
  it('routes package, shared changes and unknown files', () => {
    expect(
      route(project, ['recipes/packages/nginx/package.srx'], 'someone'),
    ).toMatchObject({
      labels: ['area:web'],
      packages: ['nginx'],
      reviewers: ['@fullzer4'],
    });
    expect(
      route(project, ['recipes/templates/process.srx'], 'someone').packages,
    ).toContain('hello');
    expect(route(project, ['new-file.txt'], 'someone').reviewers).toEqual([
      '@fullzer4',
    ]);
  });
  it('routes policy changes to security and excludes the author case-insensitively', () => {
    const result = route(project, ['.ryro-bot.toml'], 'FULLZER4');
    expect(result.labels).toContain('area:security');
    expect(result.independentReviewerPending).toBe(true);
  });
  it('unions deputies from overlapping categories', () => {
    const p = structuredClone(project);
    p.categories.security.deputies = ['@reviewer'];
    expect(route(p, ['.ryro-bot.toml'], 'fullzer4').reviewers).toEqual([
      '@reviewer',
    ]);
    expect(ownershipArtifacts(p)['.github/CODEOWNERS']).toContain(
      '@fullzer4 @reviewer',
    );
  });
  it('refuses path traversal and missing file lists', () => {
    for (const paths of [[], ['../secret'], ['/etc/passwd'], ['a\\b']])
      expect(() => route(project, paths, 'a')).toThrow();
  });
  it('pins policy from the base and refuses altered opt-in and fields', () => {
    const config = `schema = 1\nenabled = true\npolicy = "syrox-pkgs-v1"\npolicy_revision = "${revision}"\n`;
    expect(admitBaseConfig(config, project, revision)).toBe(sha256(config));
    expect(() =>
      admitBaseConfig(config.replace(revision, base), project, revision),
    ).toThrow();
    expect(() =>
      admitBaseConfig(config + 'approval = true\n', project, revision),
    ).toThrow();
    expect(() =>
      admitBaseConfig(config.replace('true', 'false'), project, revision),
    ).toThrow();
  });
});

describe('bounded planning and recovery', () => {
  it('batches thousands of versions, keeps profiles together and does not promote defaults', () => {
    const result = makePlan(
      Array.from({ length: 5000 }, (_, i) => candidate(`2.${i}.0`)),
    );
    expect(
      result.batches.every(
        (b) => b.versions.length <= 5 && b.draft && !b.promotesDefault,
      ),
    ).toBe(true);
    expect(result.estimatedCombinations).toBeLessThanOrEqual(4096);
    expect(result.queued.length).toBeGreaterThan(0);
    expect(result.batches[0].versions).toContain('2.4999.0');
  });
  it('prioritizes security and keeps prereleases discoverable', () => {
    const result = makePlan([candidate('9.0.0'), candidate('2.0.0-rc1', true)]);
    expect(result.batches[0].versions).toContain('2.0.0-rc1');
    expect(result.publicationReady).toBe(false);
  });
  it('excludes held and admitted versions, deduplicates and bounds bytes', () => {
    expect(
      makePlan([
        candidate('1.0.0'),
        { ...candidate('2.0.0'), state: 'revoked' },
      ]).batches,
    ).toHaveLength(0);
    expect(
      makePlan([candidate('2.0.0'), candidate('2.0.0')]).batches[0].versions,
    ).toHaveLength(1);
    const p = structuredClone(project);
    p.limits.lockBytes = 101;
    expect(makePlan([candidate('2.0.0')], p).batches).toHaveLength(0);
  });
  const snapshot = (): Snapshot => ({
    complete: true,
    baseSha: base,
    prs: [],
    branches: {},
  });
  it('recovers an orphaned branch and respects closed PRs', () => {
    const b = batch(),
      s = snapshot();
    s.branches[b.id] = {
      headSha: revision,
      preparedSha: revision,
      baseSha: base,
      author: 'ryro[bot]',
      humanCommits: false,
    };
    expect(reconcile([b], s, 'ryro[bot]')[0].action).toBe('recover-draft-pr');
    s.prs.push({
      batchId: b.id,
      number: 1,
      state: 'closed',
      author: 'ryro[bot]',
      headSha: revision,
      draft: true,
    });
    expect(reconcile([b], s, 'ryro[bot]')[0].action).toBe('respect-closed');
  });
  it('preserves human commits and replans a changed base', () => {
    const b = batch(),
      s = snapshot();
    s.branches[b.id] = {
      headSha: revision,
      preparedSha: revision,
      baseSha: base,
      author: 'ryro[bot]',
      humanCommits: true,
    };
    expect(reconcile([b], s, 'ryro[bot]')[0].action).toBe(
      'preserve-human-work',
    );
    s.baseSha = revision;
    expect(reconcile([b], s, 'ryro[bot]')[0].action).toBe('replan');
  });
  it('caps open PRs, fails on incomplete remote state and checks the head SHA', () => {
    const b = batch(),
      s = snapshot();
    s.prs = Array.from({ length: 4 }, (_, i) => ({
      batchId: '' + i,
      number: i,
      state: 'open',
      author: 'ryro[bot]',
      headSha: revision,
      draft: true,
    }));
    expect(reconcile([b], s, 'ryro[bot]')[0].action).toBe('queued');
    expect(() =>
      reconcile([b], { ...s, complete: false }, 'ryro[bot]'),
    ).toThrow();
    s.prs = [
      {
        batchId: b.id,
        number: 1,
        state: 'open',
        author: 'ryro[bot]',
        headSha: revision,
        draft: true,
        checksSha: base,
        checks: 'success',
      },
    ];
    s.branches[b.id] = {
      headSha: revision,
      preparedSha: revision,
      baseSha: base,
      author: 'ryro[bot]',
      humanCommits: false,
    };
    expect(reconcile([b], s, 'ryro[bot]')[0].action).toBe('request-checks');
    s.prs[0].checksSha = revision;
    s.prs[0].checks = 'failure';
    expect(reconcile([b], s, 'ryro[bot]')[0].action).toBe('wait');
  });
});

describe('webhook and discovery boundaries', () => {
  const secret = 's'.repeat(40),
    body = Buffer.from(
      JSON.stringify({
        repository: { full_name: project.repository, id: 1 },
        installation: { id: 2 },
      }),
    );
  const signature =
    'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  it('authenticates exact bytes and installation identity', () => {
    expect(verifySignature(body, signature, secret)).toBe(true);
    expect(
      verifySignature(
        Buffer.concat([body, Buffer.from(' ')]),
        signature,
        secret,
      ),
    ).toBe(false);
    expect(verifySignature(body, 'sha256=00', secret)).toBe(false);
    const config = {
      webhookSecret: Redacted.make(secret),
      bindings: {
        [project.repository]: { repositoryId: 1, installationId: 2 },
      },
    };
    expect(
      admitWebhook(
        body,
        { signature, delivery: '12345678-1234-1234', event: 'pull_request' },
        config,
      ),
    ).toBe(project.repository);
    expect(() =>
      admitWebhook(
        body,
        { signature, delivery: '12345678-1234-1234', event: 'pull_request' },
        { ...config, bindings: {} },
      ),
    ).toThrow();
  });
  it('parses historical, prerelease and development versions with pagination', () => {
    const c = project.packages.nginx.discovery!;
    const parsed = parsePage(
      Buffer.from(
        '<html><a href="nginx-1.2.0.tar.gz">old</a><a href="nginx-1.3.0.tar.gz">dev</a><a href="nginx-2.0.0-rc1.tar.gz">pre</a><a rel="next" href="?page=2">next</a>',
      ),
      new Headers(),
      c.url,
      c,
    );
    expect(parsed.versions.map((v) => v.classification)).toEqual([
      'stable',
      'development',
      'prerelease',
    ]);
    expect(parsed.next).toContain('?page=2');
    expect(() => sameOrigin('https://evil.example/a', c.origin)).toThrow();
    expect(() =>
      sameOrigin('https://user@nginx.org/download/', c.origin),
    ).toThrow();
  });
  it('decodes HTML entities once before validating pagination URLs', () => {
    const c = project.packages.nginx.discovery!;
    const next = (href: string) =>
      parsePage(
        Buffer.from(`<a rel="next" href="${href}">next</a>`),
        new Headers(),
        c.url,
        c,
      ).next;
    expect(next('?literal=&amp;quot;')).toBe(c.url + '?literal=&quot;');
    expect(next('?q=&quot;value&quot;&#38;page=2')).toBe(
      c.url + '?q=%22value%22&page=2',
    );
    expect(() => next('?literal=&amp;#38;')).toThrow(
      'untrusted-discovery-origin',
    );
  });
  it('retains API prereleases, excludes drafts and rejects cross-origin pagination', () => {
    const c = {
      ...project.packages.nginx.discovery!,
      format: 'github' as const,
      url: 'https://api.github.com/repos/a/b/releases',
      origin: 'https://api.github.com/',
    };
    const data = Buffer.from(
      JSON.stringify([
        { tag_name: 'v1.0.0-rc1', prerelease: true, draft: false },
        { tag_name: 'v1.0.0', prerelease: false, draft: true },
      ]),
    );
    expect(parsePage(data, new Headers(), c.url, c).versions).toHaveLength(1);
    expect(() =>
      parsePage(
        data,
        new Headers({ link: '<https://evil.example/>; rel="next"' }),
        c.url,
        c,
      ),
    ).toThrow();
  });
});

describe('evidence admission', () => {
  it('rejects unexpected ZIP paths and malformed archives', () => {
    expect(
      unzipPrepared(zipSync({ 'prepared.json': strToU8('{}') })).toString(),
    ).toBe('{}');
    expect(() =>
      unzipPrepared(zipSync({ '../prepared.json': strToU8('{}') })),
    ).toThrow();
    expect(() =>
      unzipPrepared(
        zipSync({ 'prepared.json': strToU8('{}'), other: strToU8('x') }),
      ),
    ).toThrow();
  });
  it('binds preparation to the successful pinned run and exact base', () => {
    const b = batch();
    const doc: Prepared = {
      schema: 1,
      batchId: b.id,
      repositoryId: 1,
      baseSha: base,
      policyRevision: revision,
      runId: 2,
      runAttempt: 1,
      defaultsBefore: {},
      files: ['catalog.toml', 'Catalog.lock', 'Syrox.lock'].map((path) => ({
        path,
        beforeBlob: base,
        content: 'eA==',
        sha256: sha256('x'),
      })),
    };
    const run: Run = {
      id: 2,
      head_sha: base,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/' + project.preparationWorkflow,
      workflow_id: 3,
      repository: { id: 1 },
      head_repository: { id: 1 },
      referenced_workflows: [
        {
          path: 'ryro-hq/ryro-bot/.github/workflows/prepare.yml@' + revision,
          sha: revision,
          ref: revision,
        },
      ],
    };
    expect(admitPrepared(doc, b, run, 1, project)).toBe(doc);
    expect(() =>
      admitPrepared({ ...doc, baseSha: revision }, b, run, 1, project),
    ).toThrow();
    expect(() =>
      admitPrepared(doc, b, { ...run, referenced_workflows: [] }, 1, project),
    ).toThrow();
    const changed = structuredClone(doc);
    changed.files[0].content = 'eQ==';
    expect(() => admitPrepared(changed, b, run, 1, project)).toThrow();
  });
  const oldCatalog =
    'schema=2\n[defaults]\nnginx="1.0.0"\n[[releases]]\nname="nginx"\nversion="1.0.0"\n[[releases.combinations]]\nvariant="minimal"\nsystem="linux-x86_64-gnu"\n';
  const add =
    '[[releases]]\nname="nginx"\nversion="2.0.0"\n[[releases.combinations]]\nvariant="minimal"\nsystem="linux-x86_64-gnu"\n';
  it('allows additions and refuses changing defaults or an existing release', () => {
    expect(() =>
      verifyCatalogAddition(
        Buffer.from(oldCatalog),
        Buffer.from(oldCatalog + add),
        batch(),
        project,
      ),
    ).not.toThrow();
    expect(() =>
      verifyCatalogAddition(
        Buffer.from(oldCatalog),
        Buffer.from(
          (oldCatalog + add).replace('nginx="1.0.0"', 'nginx="2.0.0"'),
        ),
        batch(),
        project,
      ),
    ).toThrow();
    expect(() =>
      verifyCatalogAddition(
        Buffer.from(oldCatalog),
        Buffer.from(
          (oldCatalog + add).replace(
            'system="linux-x86_64-gnu"',
            'system="linux-x86_64-musl"',
          ),
        ),
        batch(),
        project,
      ),
    ).toThrow();
  });
  it('rejects missing, altered and wrong-environment publication evidence', () => {
    const artifact = 'c'.repeat(64),
      env = 'd'.repeat(64),
      item = { artifactSha256: artifact, digest: 'e'.repeat(64) };
    const doc: PublicationEvidence = {
      schema: 1,
      artifactSha256: artifact,
      baseSha: base,
      headSha: revision,
      policyRevision: revision,
      sbom: item,
      sources: item,
      patches: item,
      licenses: item,
      provenance: item,
      qualifications: project.hosts.flatMap((host) =>
        ['linux-x86_64-gnu', 'linux-x86_64-musl'].map((system) => ({
          host,
          system,
          artifactSha256: artifact,
          environmentDigest: env,
          passed: true,
        })),
      ),
    };
    const context = {
      artifactSha256: artifact,
      baseSha: base,
      headSha: revision,
      policyRevision: revision,
      environments: Object.fromEntries(project.hosts.map((h) => [h, env])),
    };
    expect(publicationReady(doc, context, project)).toBe(true);
    expect(() =>
      publicationReady({ ...doc, qualifications: [] }, context, project),
    ).toThrow();
    expect(() =>
      publicationReady(
        { ...doc, sbom: { ...item, artifactSha256: env } },
        context,
        project,
      ),
    ).toThrow();
    expect(() =>
      publicationReady(
        doc,
        { ...context, environments: { debian: artifact } },
        project,
      ),
    ).toThrow();
  });
  it('canonicalizes object order without changing array semantics', () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});
