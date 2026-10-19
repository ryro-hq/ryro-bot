import { Effect } from 'effect';
import { DiscoveryStore, PageFetcher } from './contracts.ts';
import { sameOrigin } from '../../kernel/urls.ts';
import { BotError, requireThat } from '../../kernel/errors.ts';
import { canonical, component, sha256 } from '../../kernel/values.ts';
import type { Channel } from '../contracts/project.ts';

export function parsePage(
  body: Buffer,
  headers: Headers,
  url: string,
  channel: Channel,
) {
  const versions = new Map<
      string,
      { version: string; classification: string; originRef: string }
    >(),
    next = new Set<string>();
  const classify = (version: string) =>
    !/^\d+(?:\.\d+)+$/.test(version)
      ? 'prerelease'
      : channel.classification === 'even-minor' &&
          Number(version.split('.')[1]) % 2 === 1
        ? 'development'
        : 'stable';
  if (channel.format === 'github') {
    const entries: { draft: boolean; prerelease: boolean; tag_name: string }[] =
      JSON.parse(body.toString('utf8'));
    requireThat(
      Array.isArray(entries) && entries.length <= 100,
      'invalid-release-page',
    );
    for (const row of entries)
      if (!row.draft) {
        const version = component(row.tag_name.replace(/^v/, ''));
        versions.set(version, {
          version,
          classification: row.prerelease ? 'prerelease' : classify(version),
          originRef: row.tag_name,
        });
      }
  } else {
    const html = body.toString('utf8');
    for (const match of html.matchAll(/<(?:a|link)\b[^>]*>/gi)) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[0])?.[1];
      if (!href) continue;
      const target = new URL(decode(href), url),
        filename = decodeURIComponent(target.pathname.split('/').at(-1)!);
      if (/\brel\s*=\s*["'][^"']*\bnext\b[^"']*["']/i.test(match[0]))
        next.add(sameOrigin(target.href, channel.origin));
      if (
        filename.startsWith(channel.prefix) &&
        filename.endsWith(channel.suffix)
      ) {
        sameOrigin(target.href, channel.origin);
        const version = component(
          filename.slice(channel.prefix.length, -channel.suffix.length),
        );
        versions.set(version, {
          version,
          classification: classify(version),
          originRef: target.href,
        });
      }
    }
    requireThat(/<html|<a\b|<link\b/i.test(html), 'unrecognized-html-listing');
  }
  for (const match of (headers.get('link') ?? '').matchAll(
    /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/gi,
  )) {
    const target = match[1];
    requireThat(target, 'invalid-pagination-link');
    next.add(sameOrigin(new URL(target, url).href, channel.origin));
  }
  requireThat(next.size <= 1, 'ambiguous-pagination');
  return { versions: [...versions.values()], next: [...next][0] ?? null };
}

export const discover = (
  repository: string,
  pkg: string,
  channel: Channel,
  budget = 20,
  fetcher?: (
    url: string,
    authority: string,
    signal?: AbortSignal,
  ) => Promise<{ body: Buffer; headers: Headers }>,
) =>
  Effect.gen(function* () {
    const store = yield* DiscoveryStore;
    const fetchPage = fetcher ?? (yield* PageFetcher).fetch;
    requireThat(
      Number.isInteger(budget) && budget >= 1 && budget <= 10000,
      'invalid-page-budget',
    );
    sameOrigin(channel.url, channel.origin);
    yield* store.start(
      repository,
      pkg,
      sha256(canonical(channel)),
      channel.url,
    );
    const scan = Effect.gen(function* () {
      for (let page = 0; page < budget; page++) {
        const state = yield* store.cursor(repository, pkg);
        const response = yield* Effect.tryPromise({
          try: (signal) => fetchPage(state.cursor, channel.origin, signal),
          catch: () => new BotError({ code: 'discovery-fetch-failed' }),
        });
        const parsed = yield* Effect.try({
          try: () =>
            parsePage(response.body, response.headers, state.cursor, channel),
          catch: (e) =>
            e instanceof BotError
              ? e
              : new BotError({ code: 'discovery-parse-failed' }),
        });
        yield* store.commit(
          repository,
          pkg,
          state,
          response.body,
          parsed.versions,
          parsed.next,
        );
        if (!parsed.next) return { complete: true, pages: page + 1 };
      }
      return { complete: false, pages: budget };
    });
    return yield* scan.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* store.failed(repository, pkg);
          return yield* Effect.failCause(cause);
        }),
      ),
    );
  });
const decode = (text: string) =>
  text.replace(/&(?:amp|quot|#\d+);/g, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&quot;') return '"';
    return String.fromCodePoint(Number(entity.slice(2, -1)));
  });
