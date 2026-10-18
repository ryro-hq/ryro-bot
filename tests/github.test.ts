import { generateKeyPairSync } from 'node:crypto';
import { Redacted } from 'effect';
import { describe, expect, it } from 'vitest';
import { GitHub } from '../src/github.js';
import { sha256 } from '../src/domain.js';

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
