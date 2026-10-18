import { readFileSync } from 'node:fs';
import { Redacted } from 'effect';
import { gitSha, requireThat } from './domain.js';
import type { Binding, Mode, Project } from './domain.js';
import { validateProject } from './policy.js';

export interface Settings {
  mode: Mode;
  revision: string;
  version: string;
  host: string;
  port: number;
  webhookSecret: Redacted.Redacted<string>;
  databaseUrl: string;
  databaseCa?: string;
  localDatabase: boolean;
  appId?: string;
  appKey?: Redacted.Redacted<string>;
  appLogin?: string;
  projects: Project[];
  bindings: Record<string, Binding>;
  schedulerSeconds: number;
}
const fileSecret = (env: NodeJS.ProcessEnv, name: string) => {
  const path = env[name];
  requireThat(path, 'missing-' + name);
  const value = readFileSync(path, 'utf8').trim();
  requireThat(value.length >= 32, 'short-' + name);
  return value;
};
export function loadSettings(env = process.env): Settings {
  const mode = env.RYRO_MODE ?? 'observe';
  requireThat(['observe', 'prepare', 'publish'].includes(mode), 'invalid-mode');
  const registry = JSON.parse(
    readFileSync(env.RYRO_REGISTRY ?? 'registry/projects.json', 'utf8'),
  ) as { schema: number; projects: Project[] };
  requireThat(
    registry.schema === 1 &&
      Array.isArray(registry.projects) &&
      registry.projects.length > 0,
    'invalid-registry',
  );
  const projects = registry.projects.map(validateProject);
  requireThat(
    new Set(projects.map((p) => p.repository)).size === projects.length,
    'duplicate-project',
  );
  const port = Number(env.PORT ?? '8790'),
    schedulerSeconds = Number(env.RYRO_SCHEDULER_SECONDS ?? '300');
  requireThat(
    Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535 &&
      Number.isInteger(schedulerSeconds) &&
      schedulerSeconds >= 60,
    'invalid-listener-or-scheduler',
  );
  const bindings = JSON.parse(
    readFileSync(env.RYRO_BINDINGS_FILE ?? 'bindings.json', 'utf8'),
  ) as Record<string, Binding>;
  for (const [repository, binding] of Object.entries(bindings))
    requireThat(
      projects.some((p) => p.repository === repository) &&
        Number.isSafeInteger(binding.repositoryId) &&
        binding.repositoryId > 0 &&
        Number.isSafeInteger(binding.installationId) &&
        binding.installationId > 0,
      'invalid-installation-binding',
    );
  const appKey = env.GITHUB_APP_KEY_FILE
    ? Redacted.make(fileSecret(env, 'GITHUB_APP_KEY_FILE'))
    : undefined;
  requireThat(
    !appKey ||
      (env.GITHUB_APP_ID && /^[\w-]+\[bot\]$/.test(env.GITHUB_APP_LOGIN ?? '')),
    'missing-app-identity',
  );
  requireThat(mode === 'observe' || appKey, 'app-required-for-writes');
  return {
    mode: mode as Mode,
    revision: gitSha(env.RYRO_POLICY_REVISION ?? ''),
    version: gitSha(env.RYRO_BOT_VERSION ?? ''),
    host: env.HOST ?? '127.0.0.1',
    port,
    webhookSecret: Redacted.make(fileSecret(env, 'GITHUB_WEBHOOK_SECRET_FILE')),
    databaseUrl: fileSecret(env, 'DATABASE_URL_FILE'),
    databaseCa: env.PG_CA_FILE
      ? readFileSync(env.PG_CA_FILE, 'utf8')
      : undefined,
    localDatabase: env.RYRO_LOCAL_DATABASE === 'true',
    appId: env.GITHUB_APP_ID,
    appKey,
    appLogin: env.GITHUB_APP_LOGIN,
    projects,
    bindings,
    schedulerSeconds,
  };
}
