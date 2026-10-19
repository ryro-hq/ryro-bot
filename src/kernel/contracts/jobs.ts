export interface Job {
  id: string;
  repository: string;
  kind: string;
  payload: unknown;
  lease_token: string;
  attempts: number;
  generation?: number;
  payload_version?: number;
}
