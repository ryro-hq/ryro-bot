export interface Pull {
  number: number;
  created_at?: string;
  state: 'open' | 'closed';
  draft: boolean;
  body: string | null;
  user: { login: string };
  head: { sha: string; ref: string; repo: { id: number } };
  base: { sha: string; ref: string };
}
export interface Run {
  id: number;
  run_attempt?: number;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  path: string;
  workflow_id: number;
  repository: { id: number };
  head_repository: { id: number };
  referenced_workflows?: { path: string; sha: string; ref: string }[];
}
export interface Rule {
  type: string;
  ruleset_id: number;
  parameters?: Record<string, unknown>;
}
export interface GitHubAPI {
  get<T>(path: string): Promise<T>;
  list<T>(suffix: string, field?: string): Promise<T[]>;
  base(branch: string): Promise<string>;
  file(path: string, sha: string): Promise<Buffer>;
  pulls(): Promise<Pull[]>;
  runs(workflow: string): Promise<Run[]>;
  run(id: number): Promise<Run>;
  ref(branch: string): Promise<string | null>;
  rules(branch: string): Promise<Rule[]>;
  dispatch(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<{ workflow_run_id: number }>;
  createBlob(bytes: Buffer): Promise<{ sha: string }>;
  createCommit(
    base: string,
    changes: { path: string; sha: string }[],
    message: string,
  ): Promise<{ sha: string }>;
  createBranch(branch: string, sha: string): Promise<unknown>;
  createDraft(
    branch: string,
    base: string,
    title: string,
    body: string,
  ): Promise<Pull>;
  requestReview(number: number, reviewers: string[]): Promise<unknown>;
  addLabels(number: number, labels: string[]): Promise<unknown>;
  createLabel(label: {
    name: string;
    color: string;
    description: string;
  }): Promise<unknown>;
  artifact(id: number, digest: string): Promise<Buffer>;
}
