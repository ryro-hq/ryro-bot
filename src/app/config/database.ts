import { readFileSync } from 'node:fs';
import { requireThat } from '../../kernel/errors.ts';
export const fileValue = (env: NodeJS.ProcessEnv, name: string) => {
  requireThat(env[name], 'missing-' + name);
  const value = readFileSync(env[name], 'utf8').trim();
  requireThat(value.length > 0, 'empty-' + name);
  return value;
};
export function loadDatabaseSettings(env = process.env) {
  const databaseUrl = fileValue(env, 'DATABASE_URL_FILE');
  const parsed = new URL(databaseUrl);
  requireThat(
    ['postgres:', 'postgresql:'].includes(parsed.protocol) &&
      parsed.username &&
      parsed.pathname.length > 1,
    'invalid-database-url',
  );
  return {
    databaseUrl,
    ...(env.PG_CA_FILE
      ? { databaseCa: readFileSync(env.PG_CA_FILE, 'utf8') }
      : {}),
    localDatabase: env.RYRO_LOCAL_DATABASE === 'true',
  };
}
