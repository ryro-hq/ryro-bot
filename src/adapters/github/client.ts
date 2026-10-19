import { createSign } from 'node:crypto';
import { Redacted } from 'effect';
import { BotError, requireThat } from '../../kernel/errors.ts';
import { DeferredError } from '../../kernel/operations.ts';
import { gitSha } from '../../kernel/values.ts';
import type { Binding } from '../../modules/contracts/project.ts';
import { readBounded } from '../http/client.ts';

type Permission = 'read' | 'dispatch' | 'contents' | 'pulls';
export type { Pull, Run } from '../../modules/ci/model.ts';
import type { Pull, Run } from '../../modules/ci/model.ts';
export interface GitHubOptions {
  canonicalRepository?: string;
  signal?: AbortSignal;
  beforeWrite?(path: string): Promise<void>;
  blockedUntil?(): Promise<number>;
  cooldown?(until: number): Promise<void>;
}
const tokens = new Map<string, { value: string; expires: number }>();
const responses = new Map<string, { etag: string; value: unknown }>();
const queues = new Map<number, Promise<void>>();
const lastWrite = new Map<number, number>();
const blocked = new Map<number, number>();

export class GitHub {
  readonly repository: string;
  readonly binding: Binding;
  readonly #appId: string;
  readonly #privateKey: Redacted.Redacted<string>;
  readonly #transport: typeof fetch;
  readonly #options: GitHubOptions;
  constructor(
    repository: string,
    binding: Binding,
    appId: string,
    privateKey: Redacted.Redacted<string>,
    transport: typeof fetch = fetch,
    options: GitHubOptions = {},
  ) {
    this.repository = repository;
    this.binding = binding;
    this.#appId = appId;
    this.#privateKey = privateKey;
    this.#transport = transport;
    this.#options = options;
    requireThat(
      /^[\w-]+\/[\w.-]+$/.test(repository) &&
        /^\d+$/.test(appId) &&
        /^[\w-]+\/[\w.-]+$/.test(options.canonicalRepository ?? repository),
      'invalid-github-identity',
    );
  }
  private signal(timeout = 20000) {
    return AbortSignal.any([
      AbortSignal.timeout(timeout),
      ...(this.#options.signal ? [this.#options.signal] : []),
    ]);
  }
  private async serialized<A>(
    write: boolean,
    work: () => Promise<A>,
  ): Promise<A> {
    const id = this.binding.installationId;
    const previous = queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(id, current);
    try {
      await previous;
      this.#options.signal?.throwIfAborted();
      const until = Math.max(
        blocked.get(id) ?? 0,
        (await this.#options.blockedUntil?.()) ?? 0,
      );
      if (until > Date.now()) throw new DeferredError(until);
      if (write) {
        const delay = Math.max(0, (lastWrite.get(id) ?? 0) + 1000 - Date.now());
        if (delay)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(done, delay);
            const signal = this.#options.signal;
            function done() {
              signal?.removeEventListener('abort', abort);
              resolve();
            }
            function abort() {
              clearTimeout(timer);
              reject(signal?.reason);
            }
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          });
        this.#options.signal?.throwIfAborted();
        lastWrite.set(id, Date.now());
      }
      return await work();
    } finally {
      release();
      if (queues.get(id) === current) queues.delete(id);
    }
  }
  private async rate(response: Response) {
    if (
      response.status !== 429 &&
      !(
        response.status === 403 &&
        (response.headers.has('retry-after') ||
          response.headers.get('x-ratelimit-remaining') === '0')
      )
    )
      return;
    const retry = response.headers.get('retry-after');
    const seconds =
      retry && /^\d+$/.test(retry)
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry ?? '');
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const until = Math.max(
      Date.now() + 60000,
      Number.isFinite(seconds) ? seconds : 0,
      Number.isFinite(reset) ? reset : 0,
    );
    blocked.set(this.binding.installationId, until);
    await response.body?.cancel();
    await this.#options.cooldown?.(until);
    throw new DeferredError(until);
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
    const write = method !== 'GET';
    const appToken = path.startsWith('/app/installations/');
    const key =
      this.#appId +
      ':' +
      this.binding.installationId +
      ':' +
      this.binding.repositoryId +
      ':' +
      path;
    return this.serialized(write && !appToken, async () => {
      if (write && !appToken) await this.#options.beforeWrite?.(path);
      this.#options.signal?.throwIfAborted();
      const cached = method === 'GET' ? responses.get(key) : undefined;
      const response = await this.#transport('https://api.github.com' + path, {
        method,
        redirect: 'error',
        signal: this.signal(),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'ryro-bot/0.1',
          ...(cached ? { 'If-None-Match': cached.etag } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await this.rate(response);
      if (response.status === 304 && cached)
        return structuredClone(cached.value) as T;
      if (!response.ok) {
        await response.body?.cancel();
        throw new BotError({ code: 'github-http-' + response.status });
      }
      if (response.status === 204) return undefined as T;
      const value = JSON.parse(
        (await readBounded(response, 16 * 1024 * 1024)).toString('utf8'),
      ) as T;
      const etag = response.headers.get('etag');
      if (method === 'GET' && etag) {
        if (responses.size >= 1000)
          responses.delete(responses.keys().next().value!);
        responses.set(key, { etag, value: structuredClone(value) });
      }
      return value;
    });
  }
  private async token(operation: Permission): Promise<string> {
    const cacheKey =
      this.#appId +
      ':' +
      this.binding.installationId +
      ':' +
      this.binding.repositoryId +
      ':' +
      operation;
    const cached = tokens.get(cacheKey);
    if (cached && cached.expires > Date.now() + 60000) return cached.value;
    const now = Math.floor(Date.now() / 1000),
      encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned =
      encode({ alg: 'RS256', typ: 'JWT' }) +
      '.' +
      encode({ iat: now - 60, exp: now + 300, iss: this.#appId });
    const signer = createSign('RSA-SHA256').update(unsigned),
      jwt =
        unsigned +
        '.' +
        signer.sign(Redacted.value(this.#privateKey), 'base64url');
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
      expires_at?: string;
      permissions?: Record<string, string>;
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
    if (result.permissions)
      for (const [permission, level] of Object.entries(result.permissions)) {
        requireThat(
          (permission === 'metadata' && level === 'read') ||
            (permission in permissions &&
              level === permissions[permission as keyof typeof permissions]),
          'overprivileged-installation-token',
        );
      }
    const expires = Date.parse(result.expires_at ?? '');
    if (Number.isFinite(expires)) {
      requireThat(expires > Date.now(), 'expired-installation-token');
      if (tokens.size >= 1000) tokens.delete(tokens.keys().next().value!);
      tokens.set(cacheKey, { value: result.token, expires });
    }
    return result.token;
  }
  async get<T>(path: string): Promise<T> {
    requireThat(
      path.startsWith(`/repos/${this.repository}/`) ||
        path.startsWith(this.root() + '/'),
      'cross-repository-request',
    );
    const target = path.startsWith(`/repos/${this.repository}/`)
      ? this.root() + path.slice(('/repos/' + this.repository).length)
      : path;
    return this.request<T>('GET', target, await this.token('read'));
  }
  private root() {
    return '/repos/' + (this.#options.canonicalRepository ?? this.repository);
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
    let data = await this.get<{
      sha?: string;
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
        Number.isSafeInteger(data.size) &&
        data.size >= 0 &&
        data.size <= 4 * 1024 * 1024,
      'invalid-github-file',
    );
    if (data.encoding === 'none') {
      const blob = await this.get<{
        encoding: string;
        content: string;
        size: number;
      }>(this.root() + '/git/blobs/' + gitSha(data.sha ?? ''));
      requireThat(blob.size === data.size, 'github-file-size-mismatch');
      data = { ...data, ...blob };
    }
    requireThat(data.encoding === 'base64', 'invalid-github-file');
    const bytes = Buffer.from(data.content, 'base64');
    requireThat(bytes.length === data.size, 'github-file-size-mismatch');
    return bytes;
  }
  pulls() {
    return this.list<Pull>('/pulls?state=open&sort=created&direction=desc');
  }
  async runs(workflow: string) {
    const result = await this.get<{ workflow_runs: Run[] }>(
      this.root() +
        '/actions/workflows/' +
        encodeURIComponent(workflow) +
        '/runs?per_page=100&page=1',
    );
    requireThat(Array.isArray(result.workflow_runs), 'invalid-workflow-runs');
    return result.workflow_runs;
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
    const response = await this.serialized(false, async () => {
      const response = await this.#transport(
        'https://api.github.com' +
          this.root() +
          '/actions/artifacts/' +
          id +
          '/zip',
        {
          redirect: 'manual',
          signal: this.signal(),
          headers: {
            Authorization: 'Bearer ' + token,
            'X-GitHub-Api-Version': '2026-03-10',
          },
        },
      );
      await this.rate(response);
      return response;
    });
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
    const archive = await this.#transport(target, {
      redirect: 'error',
      signal: this.signal(30000),
    });
    requireThat(archive.ok, 'artifact-download-failed');
    const bytes = await readBounded(archive, 8 * 1024 * 1024);
    const { sha256 } = await import('../../kernel/values.ts');
    requireThat(
      expectedDigest === 'sha256:' + sha256(bytes),
      'artifact-digest-mismatch',
    );
    return bytes;
  }
  // Deliberately no review, approval, merge, ref-update, force-push or deletion API.
}
