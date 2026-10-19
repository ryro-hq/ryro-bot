import { zipSync } from 'fflate';
import type { GitHubAPI, Pull, Run } from '../../src/modules/ci/model.ts';
import type { Batch } from '../../src/modules/catalog/model.ts';
import type { Project } from '../../src/modules/contracts/project.ts';
import type { Prepared } from '../../src/modules/catalog/evidence.ts';
import { sha256 } from '../../src/kernel/values.ts';
import { base, revision } from './projects.ts';
export const catalog =
  'schema=2\n[defaults]\nnginx="1.0.0"\n[[releases]]\nname="nginx"\nversion="1.0.0"\n[[releases.combinations]]\nvariant="minimal"\nsystem="linux-x86_64-gnu"\n';
export class FakeGitHub implements GitHubAPI {
  calls: string[] = [];
  open: Pull[] = [];
  history: Pull[] = [];
  runsById = new Map<number, Run>();
  batch?: Batch;
  archive = Buffer.alloc(0);
  readonly project: Project;
  constructor(project: Project) {
    this.project = project;
  }
  async get<T>(path: string): Promise<T> {
    this.calls.push('GET ' + path);
    if (path.includes('state=all')) {
      const page = Number(
        new URL('https://api.github.com' + path).searchParams.get('page'),
      );
      return this.history.slice((page - 1) * 100, page * 100) as T;
    }
    const pr = /\/pulls\/(\d+)$/.exec(path);
    if (pr) {
      const pull =
        this.open.find((p) => p.number === Number(pr[1])) ??
        this.history.find((p) => p.number === Number(pr[1]));
      if (pull) return { ...pull, changed_files: 1, labels: [] } as T;
    }
    throw new Error('unexpected GET ' + path);
  }
  async list<T>(suffix: string): Promise<T[]> {
    this.calls.push('LIST ' + suffix);
    if (suffix.includes('/artifacts'))
      return [
        {
          id: 99,
          name: 'prepared-' + this.batch!.id + '-42',
          digest: 'sha256:' + sha256(this.archive),
          expired: false,
        },
      ] as T[];
    if (suffix.endsWith('/files'))
      return [{ filename: '.ryro-bot.toml' }] as T[];
    if (suffix.endsWith('/reviews')) return [];
    throw new Error('unexpected LIST ' + suffix);
  }
  async base() {
    return base;
  }
  async file(path: string) {
    this.calls.push('FILE ' + path);
    if (path === '.ryro-bot.toml')
      return Buffer.from(
        `schema=1\nenabled=true\npolicy="${this.project.policy}"\npolicy_revision="${revision}"\n`,
      );
    if (path === 'catalog.toml') return Buffer.from(catalog);
    if (path === 'Catalog.lock') return Buffer.from('lock');
    throw new Error('unexpected file ' + path);
  }
  async pulls() {
    return this.open;
  }
  async runs(workflow: string) {
    return [...this.runsById.values()].filter(
      (r) => r.path === '.github/workflows/' + workflow,
    );
  }
  async run(id: number) {
    const run = this.runsById.get(id);
    if (!run) throw new Error('unknown run');
    return run;
  }
  async ref() {
    return null;
  }
  async rules(): Promise<never> {
    throw new Error('publication must remain disabled');
  }
  async dispatch(
    workflow: string,
    _ref: string,
    inputs: Record<string, string>,
  ) {
    this.calls.push('DISPATCH ' + workflow);
    const run: Run = {
      id: 42,
      run_attempt: 1,
      head_sha: inputs.expected_sha,
      event: 'workflow_dispatch',
      status: 'in_progress',
      conclusion: null,
      path: '.github/workflows/' + workflow,
      workflow_id: 8,
      repository: { id: this.project.repositoryId! },
      head_repository: { id: this.project.repositoryId! },
      referenced_workflows: [
        {
          path: 'ryro-hq/ryro-bot/.github/workflows/prepare.yml@' + revision,
          sha: revision,
          ref: revision,
        },
      ],
    };
    this.runsById.set(42, run);
    return { workflow_run_id: 42 };
  }
  complete(batch: Batch, attempt = 1) {
    this.batch = batch;
    this.runsById.set(42, {
      ...this.runsById.get(42)!,
      run_attempt: attempt,
      status: 'completed',
      conclusion: 'success',
    });
    const document: Prepared = {
      schema: 1,
      batchId: batch.id,
      repositoryId: this.project.repositoryId!,
      baseSha: base,
      policyRevision: revision,
      runId: 42,
      runAttempt: attempt,
      defaultsBefore: { nginx: '1.0.0' },
      files: ['catalog.toml', 'Catalog.lock', 'Syrox.lock'].map((path) => {
        const bytes = Buffer.from(path === 'catalog.toml' ? catalog : 'lock');
        return {
          path,
          beforeBlob: base,
          sha256: sha256(bytes),
          content: bytes.toString('base64'),
        };
      }),
    };
    this.archive = Buffer.from(
      zipSync({ 'prepared.json': Buffer.from(JSON.stringify(document)) }),
    );
  }
  async artifact() {
    this.calls.push('ARTIFACT');
    return this.archive;
  }
  async createBlob(): Promise<{ sha: string }> {
    throw new Error('unexpected write');
  }
  async createCommit(): Promise<{ sha: string }> {
    throw new Error('unexpected write');
  }
  async createBranch() {
    throw new Error('unexpected write');
  }
  async createDraft(): Promise<Pull> {
    throw new Error('unexpected write');
  }
  async requestReview() {
    throw new Error('unexpected write');
  }
  async addLabels() {
    throw new Error('unexpected write');
  }
  async createLabel() {
    throw new Error('unexpected write');
  }
}
