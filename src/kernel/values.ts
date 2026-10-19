import { createHash } from 'node:crypto';
import { requireThat } from './errors.ts';
export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  }
  requireThat(value !== undefined, 'undefined-value');
  return JSON.stringify(value);
};
export function gitSha(value: string): string {
  requireThat(/^[0-9a-f]{40}$/.test(value), 'invalid-git-sha');
  return value;
}
export function component(value: string): string {
  requireThat(
    typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_.+~-]{0,127}$/.test(value),
    'invalid-component',
  );
  return value;
}
export function safePath(value: string): string {
  requireThat(
    typeof value === 'string' &&
      value.length <= 512 &&
      /^[A-Za-z0-9_./+-]+$/.test(value) &&
      !value.startsWith('/') &&
      !value.split('/').some((p) => p === '..' || p === '.' || p === ''),
    'unsafe-path',
  );
  return value;
}
