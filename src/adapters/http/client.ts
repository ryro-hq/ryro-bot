import { requireThat } from '../../kernel/errors.js';
import { BotError } from '../../kernel/errors.js';
import { sameOrigin } from '../../kernel/urls.js';
import { Layer } from 'effect';
import { PageFetcher } from '../../modules/catalog/contracts.js';
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
  signal?: AbortSignal,
): Promise<{ body: Buffer; headers: Headers }> {
  let target = sameOrigin(url, authority);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.any([
        AbortSignal.timeout(20000),
        ...(signal ? [signal] : []),
      ]),
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
export const pageFetcherLayer = Layer.succeed(PageFetcher, {
  fetch: fetchPage,
});
