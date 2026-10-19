import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { decodeProjects } from '../../src/app/config/registry.ts';
export const pilot = () => {
  const [project] = decodeProjects(
    JSON.parse(
      readFileSync(
        new URL('../../registry/projects.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  assert.ok(project, 'Pilot project must exist in the test registry');
  return structuredClone(project);
};
export const base = 'a'.repeat(40);
export const revision = 'b'.repeat(40);
