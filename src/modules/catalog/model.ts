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
