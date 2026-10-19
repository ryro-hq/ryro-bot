import { expect, it } from 'vitest';
import { decodeProjects } from '../../../src/app/config/registry.ts';
import { builtinModules } from '../../../src/app/modules.ts';
import { base, revision } from '../../support/projects.ts';
it('enables CI without requiring a package catalog', async () => {
  const projects = decodeProjects({
    schema: 2,
    projects: [
      {
        repository: 'owner/app',
        repositoryId: 123,
        policy: 'app-v1',
        fallback: ['@maintainer'],
        modules: ['ci'],
        workflows: ['test.yml'],
      },
    ],
  });
  expect(projects[0].packages).toEqual({});
  const registry = builtinModules({
    mode: 'observe',
    revision,
    version: base,
    projects,
    bindings: {},
    schedulerSeconds: 300,
  });
  expect(registry.webhook('owner/app', 'push', {}).map((i) => i.kind)).toEqual([
    'ci.reconcile',
  ]);
  expect(
    registry.webhook('owner/app', 'workflow_run', { workflow_run: { id: 7 } }),
  ).toMatchObject([
    { kind: 'ci.reconcile', scope: 'run:7', payload: { runId: 7 } },
  ]);
});
it('rejects invalid identities, ambiguous aliases, unknown modules and missing CI dependencies', () => {
  const p = {
    repository: 'owner/app',
    policy: 'app-v1',
    fallback: ['@maintainer'],
    modules: ['ci'],
  };
  for (const override of [
    { repositoryId: 0 },
    { modules: ['unknown'] },
    { modules: ['reviews'] },
  ])
    expect(() =>
      decodeProjects({ schema: 2, projects: [{ ...p, ...override }] }),
    ).toThrow();
  expect(() =>
    decodeProjects({
      schema: 2,
      projects: [
        { ...p, aliases: ['owner/old'] },
        { ...p, repository: 'owner/old' },
      ],
    }),
  ).toThrow('duplicate-repository-alias');
});
