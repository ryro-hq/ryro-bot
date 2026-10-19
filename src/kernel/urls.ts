import { requireThat } from './errors.ts';
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
