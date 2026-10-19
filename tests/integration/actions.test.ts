import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepare } from '../../src/actions/prepare.js';
import { canonical, sha256 } from '../../src/kernel/values.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Actions preparation', () => {
  function fixture(promoteDefault = false) {
    const root = mkdtempSync(join(tmpdir(), 'ryro-prepare-'));
    directories.push(root);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    const revision = 'b'.repeat(40);
    const catalog =
      'schema=2\n[defaults]\nnginx="1.0.0"\n[[releases]]\nname="nginx"\nversion="1.0.0"\n[[releases.combinations]]\nvariant="minimal"\nsystem="linux-x86_64-gnu"\n';
    writeFileSync(
      join(root, '.ryro-bot.toml'),
      `schema=1\nenabled=true\npolicy="syrox-pkgs-v1"\npolicy_revision="${revision}"\n`,
    );
    writeFileSync(join(root, 'catalog.toml'), catalog);
    for (const path of ['Catalog.lock', 'Syrox.lock'])
      writeFileSync(join(root, path), 'base');
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'base',
    );
    const base = git('rev-parse', 'HEAD'),
      cli = join(root, 'engine');
    const addition =
      '[[releases]]\nname="nginx"\nversion="2.0.0"\n[[releases.combinations]]\nvariant="minimal"\nsystem="linux-x86_64-gnu"\n';
    writeFileSync(
      cli,
      `#!${process.execPath}\nconst {writeFileSync}=require('node:fs'); const {join}=require('node:path'); if(process.argv[3]==='add'){ const root=process.argv[4]; for(const file of ['Catalog.lock','Syrox.lock']) writeFileSync(join(root,file),'new locks'); writeFileSync(join(root,'catalog.toml'),${JSON.stringify((promoteDefault ? catalog.replace('nginx="1.0.0"', 'nginx="2.0.0"') : catalog) + addition)}); }\n`,
      { mode: 0o700 },
    );
    const intent = {
      repository: 'ryro-hq/syrox-pkgs',
      package: 'nginx',
      profile: 'minimal',
      versions: ['2.0.0'],
    };
    const env = {
      EXPECTED_SHA: base,
      POLICY_REVISION: revision,
      BATCH_ID: sha256(canonical(intent)),
      PACKAGE: intent.package,
      PROFILE: intent.profile,
      VERSIONS: JSON.stringify(intent.versions),
      GITHUB_REPOSITORY: intent.repository,
      GITHUB_REPOSITORY_ID: '1380346000',
      GITHUB_RUN_ID: '2',
      GITHUB_RUN_ATTEMPT: '1',
    };
    return { root, cli, base, git, env, output: join(root, 'prepared.json') };
  }
  it('prepares exact changes without creating commits or overwriting outputs', () => {
    const f = fixture();
    const doc = prepare(f.root, f.output, f.cli, f.env);
    expect(doc.baseSha).toBe(f.base);
    expect(doc.runId).toBe(2);
    expect(doc.files.map((file) => file.path).sort()).toEqual([
      'Catalog.lock',
      'Syrox.lock',
      'catalog.toml',
    ]);
    for (const file of doc.files)
      expect(sha256(Buffer.from(file.content, 'base64'))).toBe(file.sha256);
    expect(JSON.parse(readFileSync(f.output, 'utf8'))).toEqual(doc);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.base);
    expect(() => prepare(f.root, f.output, f.cli, f.env)).toThrow();
  });
  it('accepts an existing batch after the repository has been renamed', () => {
    const f = fixture();
    const doc = prepare(f.root, f.output, f.cli, {
      ...f.env,
      GITHUB_REPOSITORY: 'ryro-hq/srx-pkgs',
    });
    expect(doc.batchId).toBe(f.env.BATCH_ID);
    expect(doc.repositoryId).toBe(1380346000);
  });
  it('rejects default promotion', () => {
    const f = fixture(true);
    expect(() => prepare(f.root, f.output, f.cli, f.env)).toThrow(
      'defaults-or-channels-changed',
    );
  });
  it('rejects command injection, excessive batches and forged context before executing tools', () => {
    const f = fixture();
    for (const overrides of [
      { PACKAGE: 'nginx;touch /tmp/injected' },
      {
        VERSIONS: JSON.stringify(
          Array.from({ length: 6 }, (_, i) => `2.${i}.0`),
        ),
      },
      { BATCH_ID: 'c'.repeat(64) },
      { GITHUB_RUN_ID: 'invalid' },
      { GITHUB_REPOSITORY_ID: '9' },
    ]) {
      expect(() =>
        prepare(f.root, f.output, '/does/not/execute', {
          ...f.env,
          ...overrides,
        }),
      ).toThrow();
    }
  });
});
