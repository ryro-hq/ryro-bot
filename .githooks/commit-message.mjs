import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const header =
  /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\([a-z0-9]+(?:[./_-][a-z0-9]+)*\)!?: \S(?:.*\S)?$/u;
const usage =
  'Use tipo(escopo): descrição — exemplo: fix(queue): corrigir retentativas';

function validate(message, label) {
  if (!header.test(message.split(/\r?\n/, 1)[0])) {
    console.error(`${label}: mensagem de commit inválida. ${usage}`);
    return false;
  }
  return true;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--edit') {
    if (!validate(readFileSync(args[1], 'utf8'), 'commit'))
      process.exitCode = 1;
  } else if (
    args.length === 4 &&
    args[0] === '--from' &&
    args[2] === '--to' &&
    [args[1], args[3]].every((value) => /^[a-f0-9]{40}$/.test(value))
  ) {
    const git = (...arguments_) =>
      execFileSync('git', arguments_, {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const commits = git('rev-list', '--reverse', args[1] + '..' + args[3])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (!commits.length) throw new Error('O intervalo precisa conter commits.');
    let valid = true;
    for (const commit of commits)
      if (
        !validate(git('show', '-s', '--format=%B', commit), commit.slice(0, 12))
      )
        valid = false;
    if (!valid) process.exitCode = 1;
  } else {
    throw new Error(
      'Uso: commit:check -- --edit ARQUIVO | --from BASE_SHA --to HEAD_SHA',
    );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Falha ao validar commits.',
  );
  process.exitCode = 1;
}
