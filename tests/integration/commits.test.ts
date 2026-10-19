import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const checker = resolve(root, 'node_modules/@commitlint/cli/cli.js');
const installer = resolve(root, 'node_modules/simple-git-hooks/cli.js');
const configuration = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
);
const directories: string[] = [];
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0',
  SKIP_INSTALL_SIMPLE_GIT_HOOKS: '0',
  SKIP_SIMPLE_GIT_HOOKS: '0',
};
for (const key of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
])
  delete env[key];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ryro commit hooks-'));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  symlinkSync(resolve(root, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      scripts: { 'commit:check': 'commitlint' },
      'simple-git-hooks': configuration['simple-git-hooks'],
      commitlint: configuration.commitlint,
    }),
  );
  const commit = (subject: string) =>
    git(
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-qsm',
      subject,
    );
  commit('chore(repo): iniciar teste');
  const base = git('rev-parse', 'HEAD');
  const check = () =>
    spawnSync(
      process.execPath,
      [checker, '--from', base, '--to', git('rev-parse', 'HEAD'), '--strict'],
      { cwd, env, encoding: 'utf8' },
    );
  return { cwd, git, commit, check, base };
}
it('accepts scoped subjects, breaking changes and DCO trailers through commitlint', () => {
  const f = fixture();
  for (const type of [
    'feat',
    'fix',
    'chore',
    'docs',
    'style',
    'refactor',
    'perf',
    'test',
    'build',
    'ci',
    'revert',
  ])
    f.commit(
      `${type}(postgres/migrations): atualizar configuração\n\nDetalhes.`,
    );
  f.commit('feat(api)!: mudar contrato');
  expect(f.check().status).toBe(0);
});
it('rejects missing types, scopes, separators and descriptions in every new commit', () => {
  const f = fixture();
  for (const subject of [
    'atualizar código',
    'fix: corrigir fila',
    'fix(): corrigir fila',
    'unknown(queue): corrigir fila',
    'Fix(queue): corrigir fila',
    'fix(Queue): corrigir fila',
    'fix(queue) corrigir fila',
    'fix(queue):corrigir fila',
    'fix(queue): ',
  ])
    f.commit(subject);
  const result = f.check();
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain('[scope-empty]');
  expect(result.stdout).toContain('[type-enum]');
  expect(result.stdout).toContain('[scope-case]');
  expect(result.stdout).toContain('[subject-empty]');
});
it('installs the managed hook, blocks an actual invalid commit and detects local bypass in CI', () => {
  const f = fixture();
  expect(
    spawnSync(process.execPath, [installer], { cwd: f.cwd, env }).status,
  ).toBe(0);
  expect(readFileSync(join(f.cwd, '.git/hooks/commit-msg'), 'utf8')).toContain(
    'npm run --silent commit:check',
  );
  const bad = spawnSync(
    'git',
    ['commit', '--allow-empty', '-qm', 'mensagem inválida'],
    { cwd: f.cwd, env, encoding: 'utf8' },
  );
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain('[type-empty]');
  expect(f.git('rev-parse', 'HEAD')).toBe(f.base);
  f.git('commit', '--allow-empty', '-qsm', 'fix(queue): corrigir retentativas');
  expect(f.check().status).toBe(0);
  f.commit('commit sem padrão');
  f.git('commit', '--allow-empty', '-qsm', 'docs(repo): atualizar instruções');
  expect(f.check().status).not.toBe(0);
});
