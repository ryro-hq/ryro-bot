import { createHash } from 'node:crypto';
import { Data } from 'effect';

export class BotError extends Data.TaggedError('BotError')<{
  readonly code: string;
}> {
  override get message() {
    return this.code;
  }
}

export function requireThat(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) throw new BotError({ code });
}
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
export type Mode = 'observe' | 'prepare' | 'publish';
export interface Candidate {
  package: string;
  version: string;
  profile: string;
  securityFix?: boolean;
  state: 'discovered' | 'blocked' | 'revoked' | 'quarantined';
}
export interface Batch {
  id: string;
  repository: string;
  package: string;
  profile: string;
  versions: string[];
  baseSha: string;
  policyRevision: string;
  draft: true;
  promotesDefault: false;
}
export interface Owner {
  owners: string[];
  deputies: string[];
}
export interface Project {
  repository: string;
  policy: string;
  baseBranch: string;
  fallback: string[];
  independentReviewers: string[];
  categories: Record<string, Owner>;
  packages: Record<
    string,
    Owner & {
      category: string;
      paths: string[];
      profiles: string[];
      discovery?: Channel;
    }
  >;
  shared: { paths: string[]; categories: string[]; affectsAll: boolean }[];
  limits: {
    versionsPerBatch: number;
    openPrs: number;
    combinations: number;
    catalogBytes: number;
    lockBytes: number;
    estimatedBytesPerCombination: number;
    actionsMatrixRows: number;
  };
  requiredChecks: string[];
  hosts: string[];
  preparationWorkflow: string;
  qualificationWorkflow: string;
  publicationEnabled: boolean;
}
export interface Channel {
  url: string;
  origin: string;
  format: 'html' | 'github';
  prefix: string;
  suffix: string;
  classification: 'numeric' | 'even-minor';
}
export interface Binding {
  repositoryId: number;
  installationId: number;
}
export interface AuditContext {
  repository: string;
  policyRevision: string;
  baseSha: string;
  producedSha: string | null;
  botVersion: string;
  evidence: unknown;
}
