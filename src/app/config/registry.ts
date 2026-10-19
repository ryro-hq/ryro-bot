import { readFileSync } from 'node:fs';
import { Schema } from 'effect';
import { component } from '../../kernel/values.ts';
import { requireThat } from '../../kernel/errors.ts';
import type { Project } from '../../modules/contracts/project.ts';
export function validateProject(project: Project): Project {
  requireThat(
    /^[\w-]+\/[\w.-]+$/.test(project.repository) &&
      /^[a-zA-Z0-9_.-]+$/.test(project.policy) &&
      /^[a-zA-Z0-9_./-]+$/.test(project.baseBranch),
    'invalid-project',
  );
  requireThat(
    project.fallback.length > 0 &&
      (!enabled(project, 'catalog') ||
        (project.hosts.includes('debian') &&
          project.hosts.includes('ubuntu-24.04'))),
    'incomplete-project',
  );
  const l = project.limits;
  requireThat(
    Number.isInteger(l.versionsPerBatch) &&
      l.versionsPerBatch >= 1 &&
      l.versionsPerBatch <= 5 &&
      Number.isInteger(l.openPrs) &&
      l.openPrs >= 1 &&
      l.openPrs <= 4,
    'invalid-budgets',
  );
  for (const value of [
    l.combinations,
    l.catalogBytes,
    l.lockBytes,
    l.estimatedBytesPerCombination,
    l.actionsMatrixRows,
  ])
    requireThat(
      Number.isSafeInteger(value) && value > 0,
      'invalid-scale-limit',
    );
  requireThat(
    l.actionsMatrixRows <= 256 && l.actionsMatrixRows >= project.hosts.length,
    'invalid-actions-matrix-budget',
  );
  const owners = [
    project.fallback,
    project.independentReviewers,
    ...Object.values(project.categories).flatMap((x) => [x.owners, x.deputies]),
    ...Object.values(project.packages).flatMap((x) => [x.owners, x.deputies]),
  ].flat();
  requireThat(
    owners.every((x) => /^@[a-z\d][a-z\d-]*$/i.test(x)),
    'individual-github-logins-required',
  );
  for (const [name, pkg] of Object.entries(project.packages)) {
    component(name);
    requireThat(
      project.categories[pkg.category] && pkg.profiles.length > 0,
      'invalid-package',
    );
    pkg.profiles.forEach(component);
  }
  for (const rule of [...Object.values(project.packages), ...project.shared]) {
    for (const pattern of rule.paths) {
      requireThat(
        /^[A-Za-z0-9_./*+-]+$/.test(pattern) &&
          !pattern.startsWith('/') &&
          !pattern.split('/').includes('..'),
        'unsafe-pattern',
      );
    }
  }
  for (const rule of project.shared)
    requireThat(
      rule.categories.every((c) => c in project.categories),
      'unknown-category',
    );
  return project;
}

export const enabled = (project: Project, module: string) =>
  (project.modules ?? ['ci', 'catalog', 'reviews']).includes(module);
const strings = Schema.mutable(Schema.Array(Schema.String));
const owner = { owners: strings, deputies: strings };
const channel = Schema.Struct({
  url: Schema.String,
  origin: Schema.String,
  format: Schema.Literals(['html', 'github']),
  prefix: Schema.String,
  suffix: Schema.String,
  classification: Schema.Literals(['numeric', 'even-minor']),
});
const projectSchema = Schema.Struct({
  repository: Schema.String,
  policy: Schema.String,
  baseBranch: Schema.String,
  repositoryId: Schema.optionalKey(Schema.Number),
  canonicalRepository: Schema.optionalKey(Schema.String),
  aliases: Schema.optionalKey(strings),
  modules: Schema.optionalKey(strings),
  workflows: Schema.optionalKey(strings),
  fallback: strings,
  independentReviewers: strings,
  categories: Schema.Record(Schema.String, Schema.Struct(owner)),
  packages: Schema.Record(
    Schema.String,
    Schema.Struct({
      ...owner,
      category: Schema.String,
      paths: strings,
      profiles: strings,
      discovery: Schema.optionalKey(channel),
    }),
  ),
  shared: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        paths: strings,
        categories: strings,
        affectsAll: Schema.Boolean,
      }),
    ),
  ),
  limits: Schema.Struct({
    versionsPerBatch: Schema.Number,
    openPrs: Schema.Number,
    combinations: Schema.Number,
    catalogBytes: Schema.Number,
    lockBytes: Schema.Number,
    estimatedBytesPerCombination: Schema.Number,
    actionsMatrixRows: Schema.Number,
  }),
  requiredChecks: strings,
  hosts: strings,
  preparationWorkflow: Schema.String,
  qualificationWorkflow: Schema.String,
  publicationEnabled: Schema.Boolean,
});
export function decodeProjects(input: unknown): Project[] {
  const registry = Schema.decodeUnknownSync(
    Schema.Struct({
      schema: Schema.Number,
      projects: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  )(input);
  requireThat(
    [1, 2].includes(registry.schema) && registry.projects.length > 0,
    'invalid-registry',
  );
  const projects = registry.projects.map((raw) => {
    const project = Schema.decodeUnknownSync(projectSchema)({
      baseBranch: 'main',
      fallback: [],
      independentReviewers: [],
      categories: {},
      packages: {},
      shared: [],
      limits: {
        versionsPerBatch: 5,
        openPrs: 4,
        combinations: 4096,
        catalogBytes: 4194304,
        lockBytes: 4194304,
        estimatedBytesPerCombination: 4096,
        actionsMatrixRows: 256,
      },
      requiredChecks: [],
      hosts: [],
      preparationWorkflow: '',
      qualificationWorkflow: '',
      publicationEnabled: false,
      ...(registry.schema === 2 ? { modules: ['ci', 'reviews'] } : {}),
      ...raw,
    });
    requireThat(
      project.repositoryId === undefined ||
        (Number.isSafeInteger(project.repositoryId) &&
          project.repositoryId > 0),
      'invalid-repository-id',
    );
    requireThat(
      !project.canonicalRepository ||
        /^[\w-]+\/[\w.-]+$/.test(project.canonicalRepository),
      'invalid-canonical-repository',
    );
    requireThat(
      (project.aliases ?? []).every((n) => /^[\w-]+\/[\w.-]+$/.test(n)),
      'invalid-repository-alias',
    );
    requireThat(
      new Set(project.modules).size === (project.modules?.length ?? 0) &&
        (project.modules ?? []).every((m) =>
          ['ci', 'catalog', 'reviews'].includes(m),
        ),
      'invalid-project-modules',
    );
    requireThat(
      (!enabled(project, 'catalog') && !enabled(project, 'reviews')) ||
        enabled(project, 'ci'),
      'features-require-ci',
    );
    for (const workflow of [
      project.preparationWorkflow,
      project.qualificationWorkflow,
      ...(project.workflows ?? []),
    ].filter(Boolean))
      requireThat(/^[\w.-]+\.ya?ml$/.test(workflow), 'invalid-workflow');
    return validateProject(project);
  });
  requireThat(
    new Set(projects.map((p) => p.repository)).size === projects.length,
    'duplicate-project',
  );
  const names = projects.flatMap((p) => [
    ...new Set(
      [p.repository, p.canonicalRepository, ...(p.aliases ?? [])].filter(
        Boolean,
      ),
    ),
  ]);
  requireThat(
    new Set(names.map((name) => name!.toLowerCase())).size === names.length,
    'duplicate-repository-alias',
  );
  const ids = projects.flatMap((p) => (p.repositoryId ? [p.repositoryId] : []));
  requireThat(new Set(ids).size === ids.length, 'duplicate-repository-id');
  return projects;
}
export const loadProjects = (env = process.env) =>
  decodeProjects(
    JSON.parse(
      readFileSync(env.RYRO_REGISTRY ?? 'registry/projects.json', 'utf8'),
    ),
  );
