import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('runs TypeScript entry points and the service module directly in Node', () => {
  const cwd = resolve(import.meta.dirname, '../..');
  for (const [args, output] of [
    [['src/admin.ts', '--help'], 'admin migrate'],
    [['src/migrate.ts', '--help'], 'migrate [apply|status|check]'],
    [
      [
        '--input-type=module',
        '--eval',
        'await import("./src/app/bootstrap.ts")',
      ],
      '',
    ],
  ] as const) {
    const result = spawnSync(process.execPath, [...args], {
      cwd,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(output);
  }
});
