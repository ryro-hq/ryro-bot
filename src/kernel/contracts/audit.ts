export interface AuditContext {
  repository: string;
  policyRevision: string;
  baseSha: string;
  producedSha: string | null;
  botVersion: string;
  evidence: unknown;
}
