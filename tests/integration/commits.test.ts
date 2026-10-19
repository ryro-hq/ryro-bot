import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const checker = resolve(
  import.meta.dirname,
  '../../.githooks/commit-message.mjs',
);
const directories: string[] = [];
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0',
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
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), 'ryro commit hooks-'));
  directories.push(path);
  return path;
};

it('accepts scoped conventional subjects, breaking changes and DCO trailers', () => {
  const file = join(temporary(), 'message');
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
  ]) {
    writeFileSync(
      file,
      `${type}(postgres/migrations): atualizar configuração\n\nDetalhes.\n\nSigned-off-by: Test <test@example.invalid>\n`,
    );
    expect(
      spawnSync(process.execPath, [checker, '--edit', file], { env }).status,
    ).toBe(0);
  }
  writeFileSync(file, 'feat(api)!: mudar contrato\r\n');
  expect(
    spawnSync(process.execPath, [checker, '--edit', file], { env }).status,
  ).toBe(0);
});

it('rejects missing types, scopes, separators and descriptions', () => {
  const file = join(temporary(), 'message');
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
    'fix(queue):  corrigir fila',
    'fix(queue): corrigir fila ',
    '',
  ]) {
    writeFileSync(file, subject + '\n');
    const result = spawnSync(process.execPath, [checker, '--edit', file], {
      env,
      encoding: 'utf8',
    });
    expect(result.status, subject).toBe(1);
    expect(result.stderr).toContain('tipo(escopo): descrição');
  }
});

it('blocks a real invalid commit and checks every new commit in a CI range', () => {
  const cwd = temporary();
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
  cpSync(resolve(checker, '..'), join(cwd, '.githooks'), { recursive: true });
  git('config', 'core.hooksPath', '.githooks');
  git('commit', '--allow-empty', '-qsm', 'chore(repo): iniciar teste');
  const base = git('rev-parse', 'HEAD');
  const invalid = spawnSync(
    'git',
    ['commit', '--allow-empty', '-qm', 'mensagem inválida'],
    { cwd, env, encoding: 'utf8' },
  );
  expect(invalid.status).not.toBe(0);
  expect(invalid.stderr).toContain('tipo(escopo): descrição');
  expect(git('rev-parse', 'HEAD')).toBe(base);
  git('commit', '--allow-empty', '-qsm', 'fix(queue): corrigir retentativas');
  const check = (from: string, to: string) =>
    spawnSync(process.execPath, [checker, '--from', from, '--to', to], {
      cwd,
      env,
      encoding: 'utf8',
    });
  expect(check(base, git('rev-parse', 'HEAD')).status).toBe(0);
  git(
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--allow-empty',
    '-qm',
    'commit sem padrão',
  );
  const bad = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-qsm', 'docs(repo): atualizar instruções');
  const result = check(base, git('rev-parse', 'HEAD'));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(bad.slice(0, 12));
  expect(check(base, base).status).toBe(1);
  expect(check('--all', bad).status).toBe(1);
});
