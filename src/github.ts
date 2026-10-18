import { createSign } from 'node:crypto';
import { Redacted } from 'effect';
import { BotError, gitSha, requireThat } from './domain.js';
import type { Binding } from './domain.js';
import { readBounded } from './discovery.js';

type Permission = 'read' | 'dispatch' | 'contents' | 'pulls';
export interface Pull {
  number: number;
  created_at?: string;
  state: 'open' | 'closed';
  draft: boolean;
  body: string | null;
  user: { login: string };
  head: { sha: string; ref: string; repo: { id: number } };
  base: { sha: string; ref: string };
}
export interface Run {
  id: number;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  path: string;
  workflow_id: number;
  repository: { id: number };
  head_repository: { id: number };
  referenced_workflows?: { path: string; sha: string; ref: string }[];
}
export class GitHub {
  constructor(
    readonly repository: string,
    readonly binding: Binding,
    private readonly appId: string,
    private readonly privateKey: Redacted.Redacted<string>,
    private readonly transport: typeof fetch = fetch,
  ) {
    requireThat(
      /^[\w-]+\/[\w.-]+$/.test(repository) && /^\d+$/.test(appId),
      'invalid-github-identity',
    );
  }
  private async request<T>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<T> {
    requireThat(
      path.startsWith('/') && !path.includes('://'),
      'invalid-github-path',
    );
    const response = await this.transport('https://api.github.com' + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'ryro-bot/0.1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new BotError({ code: 'github-http-' + response.status });
    }
    if (response.status === 204) return undefined as T;
    return JSON.parse(
      (await readBounded(response, 16 * 1024 * 1024)).toString('utf8'),
    ) as T;
  }
  private async token(operation: Permission): Promise<string> {
    const now = Math.floor(Date.now() / 1000),
      encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned =
      encode({ alg: 'RS256', typ: 'JWT' }) +
      '.' +
      encode({ iat: now - 60, exp: now + 300, iss: this.appId });
    const signer = createSign('RSA-SHA256').update(unsigned),
      jwt =
        unsigned +
        '.' +
        signer.sign(Redacted.value(this.privateKey), 'base64url');
    const permissions =
      operation === 'read'
        ? {
            contents: 'read',
            pull_requests: 'read',
            actions: 'read',
            checks: 'read',
          }
        : operation === 'dispatch'
          ? { actions: 'write' }
          : operation === 'contents'
            ? { contents: 'write' }
            : { pull_requests: 'write' };
    const result = await this.request<{
      token: string;
      repositories: { id: number }[];
    }>(
      'POST',
      `/app/installations/${this.binding.installationId}/access_tokens`,
      jwt,
      { repository_ids: [this.binding.repositoryId], permissions },
    );
    requireThat(
      result.repositories?.length === 1 &&
        result.repositories[0].id === this.binding.repositoryId &&
        result.token,
      'unscoped-installation-token',
    );
    return result.token;
  }
  async get<T>(path: string): Promise<T> {
    requireThat(
      path.startsWith(`/repos/${this.repository}/`),
      'cross-repository-request',
    );
    return this.request<T>('GET', path, await this.token('read'));
  }
  private root() {
    return '/repos/' + this.repository;
  }
  async list<T>(suffix: string, field?: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.get<T[] | Record<string, T[]>>(
        this.root() +
          suffix +
          (suffix.includes('?') ? '&' : '?') +
          'per_page=100&page=' +
          page,
      );
      const rows = field ? (data as Record<string, T[]>)[field] : (data as T[]);
      requireThat(Array.isArray(rows), 'invalid-paginated-result');
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new BotError({ code: 'incomplete-github-pagination' });
  }
  async base(branch: string) {
    const data = await this.get<{ commit: { sha: string } }>(
      this.root() + '/branches/' + encodeURIComponent(branch),
    );
    return gitSha(data.commit.sha);
  }
  async file(path: string, sha: string): Promise<Buffer> {
    const data = await this.get<{
      type: string;
      encoding: string;
      content: string;
      size: number;
    }>(
      this.root() +
        '/contents/' +
        path.split('/').map(encodeURIComponent).join('/') +
        '?ref=' +
        gitSha(sha),
    );
    requireThat(
      data.type === 'file' &&
        data.encoding === 'base64' &&
        data.size <= 4 * 1024 * 1024,
      'invalid-github-file',
    );
    const bytes = Buffer.from(data.content, 'base64');
    requireThat(bytes.length === data.size, 'github-file-size-mismatch');
    return bytes;
  }
  pulls() {
    return this.list<Pull>('/pulls?state=all&sort=created&direction=desc');
  }
  runs(workflow: string) {
    return this.list<Run>(
      '/actions/workflows/' + encodeURIComponent(workflow) + '/runs',
      'workflow_runs',
    );
  }
  run(id: number) {
    return this.get<Run>(this.root() + '/actions/runs/' + id);
  }
  async ref(branch: string): Promise<string | null> {
    try {
      return (
        await this.get<{ object: { sha: string } }>(
          this.root() + '/git/ref/heads/' + branch,
        )
      ).object.sha;
    } catch (e) {
      if (e instanceof BotError && e.code === 'github-http-404') return null;
      throw e;
    }
  }
  async rules(branch: string) {
    const rules = await this.get<
      {
        type: string;
        ruleset_id: number;
        parameters?: Record<string, unknown>;
      }[]
    >(this.root() + '/rules/branches/' + encodeURIComponent(branch));
    const pull = rules.find((r) => r.type === 'pull_request')?.parameters;
    requireThat(
      pull &&
        Number(pull.required_approving_review_count) >= 1 &&
        pull.dismiss_stale_reviews_on_push === true &&
        pull.require_last_push_approval === true &&
        pull.required_review_thread_resolution === true &&
        pull.require_code_owner_review === true,
      'human-review-protections-missing',
    );
    const checks = rules.find(
      (r) => r.type === 'required_status_checks',
    )?.parameters;
    requireThat(
      checks?.strict_required_status_checks_policy === true,
      'strict-required-checks-missing',
    );
    for (const id of new Set(rules.map((r) => r.ruleset_id))) {
      const ruleset = await this.get<{
        enforcement: string;
        bypass_actors: unknown[];
      }>(this.root() + '/rulesets/' + id + '?includes_parents=true');
      requireThat(
        ruleset.enforcement === 'active' &&
          Array.isArray(ruleset.bypass_actors) &&
          ruleset.bypass_actors.length === 0,
        'ruleset-bypass-or-inactive',
      );
    }
    return rules;
  }
  async dispatch(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ) {
    return this.request<{ workflow_run_id: number }>(
      'POST',
      this.root() +
        '/actions/workflows/' +
        encodeURIComponent(workflow) +
        '/dispatches',
      await this.token('dispatch'),
      { ref, inputs },
    );
  }
  async createBlob(bytes: Buffer) {
    return this.request<{ sha: string }>(
      'POST',
      this.root() + '/git/blobs',
      await this.token('contents'),
      { content: bytes.toString('base64'), encoding: 'base64' },
    );
  }
  async createCommit(
    baseSha: string,
    changes: { path: string; sha: string }[],
    message: string,
  ) {
    const base = await this.get<{ tree: { sha: string } }>(
      this.root() + '/git/commits/' + gitSha(baseSha),
    );
    const tree = await this.request<{ sha: string }>(
      'POST',
      this.root() + '/git/trees',
      await this.token('contents'),
      {
        base_tree: base.tree.sha,
        tree: changes.map((c) => ({
          path: c.path,
          sha: c.sha,
          type: 'blob',
          mode: '100644',
        })),
      },
    );
    return this.request<{ sha: string }>(
      'POST',
      this.root() + '/git/commits',
      await this.token('contents'),
      { message, tree: tree.sha, parents: [baseSha] },
    );
  }
  async createBranch(branch: string, sha: string) {
    requireThat(/^ryro-bot\/[0-9a-f]{64}$/.test(branch), 'invalid-bot-branch');
    return this.request(
      'POST',
      this.root() + '/git/refs',
      await this.token('contents'),
      {
        ref: 'refs/heads/' + branch,
        sha: gitSha(sha),
      },
    );
  }
  async createDraft(branch: string, base: string, title: string, body: string) {
    requireThat(/^ryro-bot\/[0-9a-f]{64}$/.test(branch), 'invalid-bot-branch');
    return this.request<Pull>(
      'POST',
      this.root() + '/pulls',
      await this.token('pulls'),
      {
        head: branch,
        base,
        title,
        body,
        draft: true,
      },
    );
  }
  async requestReview(number: number, reviewers: string[]) {
    requireThat(
      reviewers.length > 0 && reviewers.every((r) => /^[\w-]+$/.test(r)),
      'invalid-reviewers',
    );
    return this.request(
      'POST',
      this.root() + '/pulls/' + number + '/requested_reviewers',
      await this.token('pulls'),
      { reviewers },
    );
  }
  async addLabels(number: number, labels: string[]) {
    requireThat(
      labels.every((label) => /^area:[a-z][a-z0-9-]*$/.test(label)),
      'invalid-routing-labels',
    );
    return this.request(
      'POST',
      this.root() + '/issues/' + number + '/labels',
      await this.token('pulls'),
      { labels },
    );
  }
  async createLabel(label: {
    name: string;
    color: string;
    description: string;
  }) {
    requireThat(
      /^area:[a-z][a-z0-9-]*$/.test(label.name),
      'invalid-routing-label',
    );
    return this.request(
      'POST',
      this.root() + '/labels',
      await this.token('pulls'),
      label,
    );
  }
  async artifact(id: number, expectedDigest: string): Promise<Buffer> {
    const token = await this.token('read');
    const response = await this.transport(
      'https://api.github.com' +
        this.root() +
        '/actions/artifacts/' +
        id +
        '/zip',
      {
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2026-03-10',
        },
      },
    );
    requireThat(response.status === 302, 'artifact-redirect-required');
    await response.body?.cancel();
    const target = new URL(response.headers.get('location') ?? '');
    requireThat(
      target.protocol === 'https:' &&
        !target.username &&
        !target.password &&
        (target.hostname.endsWith('.blob.core.windows.net') ||
          target.hostname.endsWith('.actions.githubusercontent.com')),
      'invalid-artifact-host',
    );
    const archive = await this.transport(target, {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    requireThat(archive.ok, 'artifact-download-failed');
    const bytes = await readBounded(archive, 8 * 1024 * 1024);
    const { sha256 } = await import('./domain.js');
    requireThat(
      expectedDigest === 'sha256:' + sha256(bytes),
      'artifact-digest-mismatch',
    );
    return bytes;
  }
  // Deliberately no review, approval, merge, ref-update, force-push or deletion API.
}
