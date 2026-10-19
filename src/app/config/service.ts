import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Redacted, Schema } from 'effect';
import { gitSha } from '../../kernel/values.js';
import { requireThat } from '../../kernel/errors.js';
import type {
  Binding,
  Mode,
  Project,
} from '../../modules/contracts/project.js';
import { fileValue, loadDatabaseSettings } from './database.js';
import { loadProjects } from './registry.js';
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
  workerConcurrency?: number;
}
export type AdminSettings = Omit<Settings, 'host' | 'port' | 'webhookSecret'>;
export function loadAdminSettings(env = process.env): AdminSettings {
  const mode = env.RYRO_MODE ?? 'observe';
  requireThat(['observe', 'prepare', 'publish'].includes(mode), 'invalid-mode');
  const projects = loadProjects(env);
  const bindings = env.RYRO_BINDINGS_FILE
    ? Schema.decodeUnknownSync(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            repositoryId: Schema.Number,
            installationId: Schema.Number,
          }),
        ),
      )(JSON.parse(readFileSync(env.RYRO_BINDINGS_FILE, 'utf8')))
    : {};
  const normalized: Record<string, Binding> = {};
  const boundIds = new Set<number>();
  for (const [repository, binding] of Object.entries(bindings)) {
    const project = projects.find((p) =>
      [p.repository, p.canonicalRepository, ...(p.aliases ?? [])].includes(
        repository,
      ),
    );
    requireThat(
      project &&
        Number.isSafeInteger(binding.repositoryId) &&
        binding.repositoryId > 0 &&
        Number.isSafeInteger(binding.installationId) &&
        binding.installationId > 0 &&
        (!project.repositoryId ||
          project.repositoryId === binding.repositoryId),
      'invalid-installation-binding',
    );
    requireThat(
      !normalized[project.repository] && !boundIds.has(binding.repositoryId),
      'duplicate-installation-binding',
    );
    normalized[project.repository] = binding;
    boundIds.add(binding.repositoryId);
  }
  const appKey = env.GITHUB_APP_KEY_FILE
    ? Redacted.make(fileValue(env, 'GITHUB_APP_KEY_FILE'))
    : undefined;
  if (appKey) {
    const key = createPrivateKey(Redacted.value(appKey));
    requireThat(
      key.asymmetricKeyType === 'rsa' &&
        (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048,
      'invalid-app-key',
    );
    requireThat(
      /^\d+$/.test(env.GITHUB_APP_ID ?? '') &&
        /^[\w-]+\[bot\]$/.test(env.GITHUB_APP_LOGIN ?? ''),
      'missing-app-identity',
    );
  }
  requireThat(mode === 'observe' || appKey, 'app-required-for-writes');
  const schedulerSeconds = Number(env.RYRO_SCHEDULER_SECONDS ?? '300');
  const workerConcurrency = Number(env.RYRO_WORKERS ?? '4');
  requireThat(
    Number.isInteger(schedulerSeconds) &&
      schedulerSeconds >= 60 &&
      Number.isInteger(workerConcurrency) &&
      workerConcurrency >= 1 &&
      workerConcurrency <= 32,
    'invalid-scheduler-or-workers',
  );
  return {
    ...loadDatabaseSettings(env),
    mode: mode as Mode,
    revision: gitSha(env.RYRO_POLICY_REVISION ?? ''),
    version: gitSha(env.RYRO_BOT_VERSION ?? ''),
    appId: env.GITHUB_APP_ID,
    appKey,
    appLogin: env.GITHUB_APP_LOGIN,
    projects,
    bindings: normalized,
    schedulerSeconds,
    workerConcurrency,
  };
}
export function loadSettings(env = process.env): Settings {
  const settings = loadAdminSettings(env);
  const port = Number(env.PORT ?? '8790');
  requireThat(
    Number.isInteger(port) && port >= 1 && port <= 65535,
    'invalid-port',
  );
  const secret = fileValue(env, 'GITHUB_WEBHOOK_SECRET_FILE');
  requireThat(secret.length >= 32, 'short-GITHUB_WEBHOOK_SECRET_FILE');
  return {
    ...settings,
    host: env.HOST ?? '127.0.0.1',
    port,
    webhookSecret: Redacted.make(secret),
  };
}
