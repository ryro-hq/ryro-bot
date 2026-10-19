import { readFileSync } from 'node:fs';
import { decodeProjects } from '../../src/app/config/registry.js';
export const pilot = () =>
  structuredClone(
    decodeProjects(
      JSON.parse(
        readFileSync(
          new URL('../../registry/projects.json', import.meta.url),
          'utf8',
        ),
      ),
    )[0],
  );
export const base = 'a'.repeat(40);
export const revision = 'b'.repeat(40);
