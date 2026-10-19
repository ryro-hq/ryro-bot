import { generateKeyPairSync } from 'node:crypto';
import { Redacted } from 'effect';
import { describe, expect, it } from 'vitest';
import { GitHub } from '../../../src/adapters/github/client.js';
import { sha256 } from '../../../src/kernel/values.js';

const privateKey = Redacted.make(
  generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
);
describe('GitHub capability and credential boundaries', () => {
  it('uses a signed short-lived App JWT and a single-repository token narrowed per operation', async () => {
    const requests: { url: string; body: unknown; headers: Headers }[] = [];
    const transport = (async (
      input: URL | string | Request,
      init?: RequestInit,
    ) => {
      const url = String(input),
        body = init?.body ? JSON.parse(init.body as string) : null,
        headers = new Headers(init?.headers);
      requests.push({ url, body, headers });
      if (url.includes('/access_tokens'))
        return Response.json({
          token: 'installation-only',
          repositories: [{ id: 7 }],
        });
      return Response.json({ workflow_run_id: 9 });
    }) as typeof fetch;
    const api = new GitHub(
      'owner/repo',
      { repositoryId: 7, installationId: 8 },
      '123',
      privateKey,
      transport,
    );
    await api.dispatch('prepare.yml', 'main', { expected_sha: 'a'.repeat(40) });
    expect(requests[0].body).toEqual({
      repository_ids: [7],
      permissions: { actions: 'write' },
    });
    const jwt = requests[0].headers.get('authorization')!.split(' ')[1];
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString(),
    );
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(360);
    expect(requests[1].headers.get('authorization')).toBe(
      'Bearer installation-only',
    );
    expect(requests[1].headers.get('X-GitHub-Api-Version')).toBe('2026-03-10');
  });
  it('rejects broad token responses and cross-repository requests', async () => {
    const transport = (async () =>
      Response.json({
        token: 'unsafe',
        repositories: [{ id: 7 }, { id: 9 }],
      })) as typeof fetch;
    const api = new GitHub(
      'owner/repo',
      { repositoryId: 7, installationId: 8 },
      '123',
      privateKey,
      transport,
    );
    await expect(api.dispatch('a.yml', 'main', {})).rejects.toThrow(
      'unscoped-installation-token',
    );
    await expect(api.get('/repos/other/repo/pulls')).rejects.toThrow(
      'cross-repository-request',
    );
  });
  it('contains no merge, approval or force-update capability', () => {
    const names = Object.getOwnPropertyNames(GitHub.prototype);
    expect(
      names.some((n) =>
        /merge|approve|reviewPull|updateRef|deleteBranch/i.test(n),
      ),
    ).toBe(false);
  });
  it('does not expose remote response bodies in errors', async () => {
    let calls = 0;
    const transport = (async () =>
      ++calls === 1
        ? Response.json({ token: 'installation', repositories: [{ id: 7 }] })
        : new Response('secret-provider-payload', {
            status: 500,
          })) as typeof fetch;
    const api = new GitHub(
      'owner/repo',
      { repositoryId: 7, installationId: 8 },
      '123',
      privateKey,
      transport,
    );
    await expect(api.base('main')).rejects.toThrow('github-http-500');
  });
  it('downloads artifacts without forwarding the App token and verifies archive bytes', async () => {
    const bytes = Buffer.from('archive'),
      requests: Headers[] = [];
    const transport = (async (
      input: URL | string | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push(new Headers(init?.headers));
      if (url.includes('access_tokens'))
        return Response.json({
          token: 'installation',
          repositories: [{ id: 7 }],
        });
      if (url.includes('api.github.com'))
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://storage.blob.core.windows.net/container/artifact?sig=temporary',
          },
        });
      return new Response(bytes);
    }) as typeof fetch;
    const api = new GitHub(
      'owner/repo',
      { repositoryId: 7, installationId: 8 },
      '123',
      privateKey,
      transport,
    );
    expect(await api.artifact(9, 'sha256:' + sha256(bytes))).toEqual(bytes);
    expect(requests.at(-1)!.has('authorization')).toBe(false);
    await expect(api.artifact(9, 'sha256:' + '0'.repeat(64))).rejects.toThrow(
      'artifact-digest-mismatch',
    );
  });
  it('requires effective human review and rejects bypass actors', async () => {
    const rules = [
      {
        type: 'pull_request',
        ruleset_id: 1,
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: true,
          required_review_thread_resolution: true,
          require_code_owner_review: true,
        },
      },
      {
        type: 'required_status_checks',
        ruleset_id: 1,
        parameters: { strict_required_status_checks_policy: true },
      },
    ];
    const transport = (async (input: URL | string | Request) => {
      const url = String(input);
      if (url.includes('access_tokens'))
        return Response.json({
          token: 'installation',
          repositories: [{ id: 7 }],
        });
      if (url.includes('rules/branches')) return Response.json(rules);
      return Response.json({
        enforcement: 'active',
        bypass_actors: [{ actor_id: 123, actor_type: 'Integration' }],
      });
    }) as typeof fetch;
    const api = new GitHub(
      'owner/repo',
      { repositoryId: 7, installationId: 8 },
      '123',
      privateKey,
      transport,
    );
    await expect(api.rules('main')).rejects.toThrow(
      'ruleset-bypass-or-inactive',
    );
  });
});

describe('GitHub runtime coordination', () => {
  it('caches expiring tokens per repository and permission and revalidates ETags', async () => {
    const tokenPermissions: unknown[] = [];
    const urls: string[] = [];
    let reads = 0;
    const transport = (async (
      input: URL | string | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('access_tokens')) {
        tokenPermissions.push(JSON.parse(String(init?.body)).permissions);
        return Response.json({
          token: 'scoped',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          repositories: [{ id: 71 }],
        });
      }
      if (url.includes('/dispatches'))
        return Response.json({ workflow_run_id: 5 }, { status: 201 });
      reads++;
      if (reads === 2) {
        expect(new Headers(init?.headers).get('if-none-match')).toBe(
          '"branch"',
        );
        return new Response(null, { status: 304 });
      }
      return Response.json(
        { commit: { sha: 'a'.repeat(40) } },
        { headers: { etag: '"branch"' } },
      );
    }) as typeof fetch;
    const api = new GitHub(
      'owner/old',
      { repositoryId: 71, installationId: 81 },
      '123',
      privateKey,
      transport,
      { canonicalRepository: 'owner/new' },
    );
    expect(await api.base('main')).toBe('a'.repeat(40));
    expect(await api.base('main')).toBe('a'.repeat(40));
    await api.dispatch('test.yml', 'main', {});
    expect(tokenPermissions).toHaveLength(2);
    expect(tokenPermissions[1]).toEqual({ actions: 'write' });
    expect(
      urls
        .filter((u) => u.includes('/repos/'))
        .every((u) => u.includes('/repos/owner/new/')),
    ).toBe(true);
  });
  it('records cooldown and returns work to the queue instead of sleeping through a rate limit', async () => {
    let calls = 0,
      cooldown = 0;
    const transport = (async (input: URL | string | Request) => {
      calls++;
      if (String(input).includes('access_tokens'))
        return Response.json({
          token: 'scoped',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          repositories: [{ id: 72 }],
        });
      return new Response(null, {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    }) as typeof fetch;
    const api = new GitHub(
      'owner/rate',
      { repositoryId: 72, installationId: 82 },
      '123',
      privateKey,
      transport,
      {
        cooldown: async (until) => {
          cooldown = until;
        },
      },
    );
    await expect(api.base('main')).rejects.toThrow('github-rate-limited');
    expect(cooldown).toBeGreaterThan(Date.now() + 110000);
    await expect(api.base('main')).rejects.toThrow('github-rate-limited');
    expect(calls).toBe(2);
  });
  it('serializes requests from multiple clients for the same installation', async () => {
    let active = 0,
      max = 0;
    const transport = (async (input: URL | string | Request) => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return String(input).includes('access_tokens')
        ? Response.json({ token: 'scoped', repositories: [{ id: 73 }] })
        : Response.json({ commit: { sha: 'a'.repeat(40) } });
    }) as typeof fetch;
    const client = () =>
      new GitHub(
        'owner/serial',
        { repositoryId: 73, installationId: 83 },
        '123',
        privateKey,
        transport,
      );
    await Promise.all([client().base('main'), client().base('main')]);
    expect(max).toBe(1);
  });
  it('propagates cancellation to an in-flight request and fences writes before sending', async () => {
    const controller = new AbortController();
    let aborted = false,
      writes = 0;
    const transport = (async (
      input: URL | string | Request,
      init?: RequestInit,
    ) => {
      if (String(input).includes('access_tokens'))
        return Response.json({ token: 'scoped', repositories: [{ id: 74 }] });
      if (init?.method === 'POST') {
        writes++;
        return Response.json({});
      }
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(init.signal?.reason);
          },
          { once: true },
        );
        controller.abort(new Error('lost lease'));
      });
    }) as typeof fetch;
    const api = new GitHub(
      'owner/abort',
      { repositoryId: 74, installationId: 84 },
      '123',
      privateKey,
      transport,
      { signal: controller.signal },
    );
    await expect(api.base('main')).rejects.toThrow('lost lease');
    expect(aborted).toBe(true);
    await expect(api.dispatch('test.yml', 'main', {})).rejects.toThrow(
      'lost lease',
    );
    expect(writes).toBe(0);
  });
  it('reads bounded files larger than the Contents inline encoding limit', async () => {
    const bytes = Buffer.alloc(1100000, 97);
    const transport = (async (input: URL | string | Request) => {
      const url = String(input);
      if (url.includes('access_tokens'))
        return Response.json({
          token: 'scoped',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          repositories: [{ id: 75 }],
        });
      if (url.includes('/contents/'))
        return Response.json({
          type: 'file',
          encoding: 'none',
          size: bytes.length,
          sha: 'b'.repeat(40),
        });
      return Response.json({
        encoding: 'base64',
        content: bytes.toString('base64'),
        size: bytes.length,
      });
    }) as typeof fetch;
    const api = new GitHub(
      'owner/large',
      { repositoryId: 75, installationId: 85 },
      '123',
      privateKey,
      transport,
    );
    expect(await api.file('catalog.toml', 'a'.repeat(40))).toEqual(bytes);
  });
});
