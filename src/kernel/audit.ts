import { Effect } from 'effect';
import { AuditStore } from './contracts/persistence.js';
import type { AuditContext } from './contracts/audit.js';
export const audit = (operation: string, context: AuditContext) =>
  Effect.flatMap(AuditStore, (s) => s.write(operation, context));
export const saveEvidence = (
  repository: string,
  document: unknown,
  source: unknown,
) =>
  Effect.flatMap(AuditStore, (s) => s.evidence(repository, document, source));
