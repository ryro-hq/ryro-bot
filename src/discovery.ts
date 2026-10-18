import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import {
  BotError,
  canonical,
  component,
  requireThat,
  sha256,
} from './domain.js';
import type { Channel } from './domain.js';

export function sameOrigin(url: string, authority: string) {
  const parsed = new URL(url),
    accepted = new URL(authority);
  requireThat(
    parsed.protocol === 'https:' &&
      accepted.protocol === 'https:' &&
      parsed.origin === accepted.origin &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      (parsed.port === '' || parsed.port === '443'),
    'untrusted-discovery-origin',
  );
  return parsed.href;
}
export async function readBounded(
  response: Response,
  limit: number,
): Promise<Buffer> {
  requireThat(response.body, 'missing-response-body');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      requireThat(size <= limit, 'response-size-limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export async function fetchPage(
  url: string,
  authority: string,
): Promise<{ body: Buffer; headers: Headers }> {
  let target = sameOrigin(url, authority);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        'User-Agent': 'ryro-bot/0.1',
        Accept: 'application/json,text/html',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      requireThat(response.headers.get('location'), 'invalid-redirect');
      target = sameOrigin(
        new URL(response.headers.get('location')!, target).href,
        authority,
      );
      continue;
    }
    requireThat(response.ok, 'discovery-http-' + response.status);
    return {
      body: await readBounded(response, 4 * 1024 * 1024),
      headers: response.headers,
    };
  }
  throw new BotError({ code: 'discovery-redirect-limit' });
}
const decode = (text: string) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"');
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
  ))
    next.add(sameOrigin(new URL(match[1], url).href, channel.origin));
  requireThat(next.size <= 1, 'ambiguous-pagination');
  return { versions: [...versions.values()], next: [...next][0] ?? null };
}

export const discover = (
  repository: string,
  pkg: string,
  channel: Channel,
  budget = 20,
  fetcher = fetchPage,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      digest = sha256(canonical(channel));
    requireThat(
      Number.isInteger(budget) && budget >= 1 && budget <= 10000,
      'invalid-page-budget',
    );
    sameOrigin(channel.url, channel.origin);
    yield* sql`INSERT INTO channels (repository,package,policy_digest,generation,cursor) VALUES (${repository},${pkg},${digest},${randomUUID()},${channel.url}) ON CONFLICT DO NOTHING`;
    const existing = yield* sql<{
      policy_digest: string;
      complete: boolean;
      assessed_at: Date | null;
    }>`SELECT * FROM channels WHERE repository=${repository} AND package=${pkg}`;
    requireThat(
      existing[0].policy_digest === digest,
      'discovery-authority-changed-review-required',
    );
    if (existing[0].complete) {
      // Keep prior evidence; a new generation refreshes new releases without erasing history.
      yield* sql`UPDATE channels SET complete=FALSE,cursor=${channel.url},generation=${randomUUID()} WHERE repository=${repository} AND package=${pkg}`;
    }
    const scan = Effect.gen(function* () {
      for (let page = 0; page < budget; page++) {
        const [state] = yield* sql<{
          cursor: string;
          generation: string;
        }>`SELECT cursor,generation FROM channels WHERE repository=${repository} AND package=${pkg}`;
        const response = yield* Effect.tryPromise({
          try: () => fetcher(state.cursor, channel.origin),
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
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const locked = yield* sql<{
              cursor: string;
              generation: string;
            }>`SELECT cursor,generation FROM channels WHERE repository=${repository} AND package=${pkg} FOR UPDATE`;
            if (
              locked[0].cursor !== state.cursor ||
              locked[0].generation !== state.generation
            )
              return yield* new BotError({ code: 'discovery-cursor-race' });
            if (parsed.next) {
              const seen =
                yield* sql`SELECT 1 FROM discovery_pages WHERE repository=${repository} AND package=${pkg} AND generation=${state.generation} AND url=${parsed.next}`;
              if (parsed.next === state.cursor || seen.length)
                return yield* new BotError({ code: 'pagination-cycle' });
            }
            for (const row of parsed.versions) {
              const old = yield* sql<{
                classification: string;
                origin_ref: string;
              }>`SELECT classification,origin_ref FROM releases WHERE repository=${repository} AND package=${pkg} AND version=${row.version}`;
              if (
                old.length &&
                (old[0].classification !== row.classification ||
                  old[0].origin_ref !== row.originRef)
              )
                return yield* new BotError({
                  code: 'conflicting-release-observation',
                });
              yield* sql`INSERT INTO releases (repository,package,version,classification,origin_ref) VALUES (${repository},${pkg},${row.version},${row.classification},${row.originRef}) ON CONFLICT DO NOTHING`;
            }
            yield* sql`INSERT INTO discovery_pages (repository,package,generation,url,digest,body) VALUES (${repository},${pkg},${state.generation},${state.cursor},${sha256(response.body)},decode(${response.body.toString('hex')},'hex'))`;
            yield* sql`UPDATE channels SET cursor=${parsed.next},complete=${parsed.next === null},last_error=NULL,assessed_at=clock_timestamp() WHERE repository=${repository} AND package=${pkg}`;
          }),
        );
        if (!parsed.next) return { complete: true, pages: page + 1 };
      }
      return { complete: false, pages: budget };
    });
    return yield* scan.pipe(
      Effect.catch((e) =>
        Effect.gen(function* () {
          yield* sql`UPDATE channels SET complete=FALSE,last_error='discovery-failed' WHERE repository=${repository} AND package=${pkg}`;
          return yield* Effect.fail(e);
        }),
      ),
    );
  });
