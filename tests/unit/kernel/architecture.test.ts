import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '../../..');
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(resolve(directory, e.name))
      : e.name.endsWith('.ts')
        ? [resolve(directory, e.name)]
        : [],
  );
}
it('keeps the kernel independent and product modules behind ports', () => {
  for (const area of ['kernel', 'modules'])
    for (const file of files(resolve(root, 'src', area))) {
      const imports = [
        ...readFileSync(file, 'utf8').matchAll(
          /(?:from\s*|import\s*\()['"]([^'"]+)['"]/g,
        ),
      ].map((m) => m[1]);
      for (const dependency of imports) {
        expect(dependency, `${file}: ${dependency}`).not.toMatch(
          /adapters|app\/|effect\/sql|@effect\/sql|node:http|node:child_process/,
        );
        if (area === 'kernel') expect(dependency).not.toMatch(/modules\//);
      }
    }
});
it('preserves executable and reusable workflow entry points', () => {
  for (const name of [
    'main.ts',
    'admin.ts',
    'migrate.ts',
    'actions/prepare.ts',
  ])
    expect(readFileSync(resolve(root, 'src', name), 'utf8')).toBeTruthy();
  expect(
    readFileSync(resolve(root, '.github/workflows/prepare.yml'), 'utf8'),
  ).toContain('.ryro-bot/dist/actions/prepare.js');
  expect(readFileSync(resolve(root, 'Dockerfile'), 'utf8')).toContain(
    'dist/main.js',
  );
});
