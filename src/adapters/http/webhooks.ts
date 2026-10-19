import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Effect, Redacted } from 'effect';
import { BotError, requireThat } from '../../kernel/errors.ts';
import type { Settings } from '../../app/config/service.ts';
import { receive } from '../../kernel/jobs.ts';

export function verifySignature(
  body: Buffer,
  signature: string,
  secret: string,
) {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const actual = Buffer.from(signature.slice(7), 'hex'),
    expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(actual, expected);
}
async function bodyBytes(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    requireThat(length <= 2 * 1024 * 1024, 'webhook-size-limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function admitWebhook(
  body: Buffer,
  headers: { signature: string; delivery: string; event: string },
  settings: Pick<Settings, 'webhookSecret' | 'bindings'>,
) {
  requireThat(
    verifySignature(
      body,
      headers.signature,
      Redacted.value(settings.webhookSecret),
    ),
    'invalid-signature',
  );
  requireThat(
    /^[a-f\d-]{16,64}$/i.test(headers.delivery) &&
      /^[a-z_]{1,64}$/.test(headers.event),
    'invalid-webhook-headers',
  );
  const payload = JSON.parse(body.toString('utf8')) as {
    installation?: { id: number };
    repository?: { id: number; full_name: string };
  };
  if (headers.event === 'ping') return null;
  const repo = payload.repository;
  const entry =
    repo &&
    Object.entries(settings.bindings).find(
      ([, binding]) => binding.repositoryId === repo.id,
    );
  const binding = entry?.[1];
  requireThat(
    repo &&
      binding &&
      repo.id === binding.repositoryId &&
      payload.installation?.id === binding.installationId,
    'unregistered-installation-or-repository',
  );
  return entry![0];
}

export function webhookServer(
  settings: Settings,
  persist: (
    delivery: string,
    repository: string,
    event: string,
    body: Buffer,
  ) => Promise<unknown>,
  healthy: () => Promise<unknown>,
) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        await healthy();
        response.writeHead(200).end('ok');
        return;
      }
      if (request.method !== 'POST' || request.url !== '/github/webhook') {
        response.writeHead(404).end();
        return;
      }
      const body = await bodyBytes(request);
      const header = (name: string) =>
        typeof request.headers[name] === 'string'
          ? (request.headers[name] as string)
          : '';
      const event = header('x-github-event'),
        delivery = header('x-github-delivery');
      const repository = admitWebhook(
        body,
        { signature: header('x-hub-signature-256'), delivery, event },
        settings,
      );
      if (repository) await persist(delivery, repository, event, body);
      response.writeHead(202).end();
    } catch (error) {
      const code =
        error instanceof BotError ? error.code : 'webhook-unavailable';
      const status =
        code === 'invalid-signature'
          ? 401
          : code === 'webhook-size-limit'
            ? 413
            : code === 'unregistered-installation-or-repository'
              ? 403
              : code === 'invalid-webhook-headers' ||
                  error instanceof SyntaxError
                ? 400
                : 503;
      response.writeHead(status).end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 100;
  return server;
}
export const persistWebhook = (
  delivery: string,
  repository: string,
  event: string,
  body: Buffer,
) =>
  receive(delivery, repository, event, body).pipe(
    Effect.mapError(() => new BotError({ code: 'webhook-database-failed' })),
  );
