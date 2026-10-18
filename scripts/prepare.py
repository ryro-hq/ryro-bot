#!/usr/bin/env python3
"""Run only in the unprivileged Actions preparation job, never in the App service."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib


def require(condition):
    if not condition:
        raise ValueError("untrusted or incomplete preparation/fixture input")


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def prepare(root, output, cli, env=os.environ):
    root, output = Path(root).resolve(), Path(output).resolve()
    expected, revision, batch_id = (env[k] for k in ('EXPECTED_SHA', 'POLICY_REVISION', 'BATCH_ID'))
    package, profile = env['PACKAGE'], env['PROFILE']
    versions = json.loads(env['VERSIONS'])
    require(re.fullmatch(r'[0-9a-f]{40}', expected) and re.fullmatch(r'[0-9a-f]{40}', revision))
    require(re.fullmatch(r'[0-9a-f]{64}', batch_id))
    require(all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.+~-]{0,127}', v) for v in [package, profile]))
    require(isinstance(versions, list) and 1 <= len(versions) <= 5 and len(set(versions)) == len(versions))
    require(all(isinstance(v, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.+~-]{0,127}', v) for v in versions))
    intent = dict(repository=env['GITHUB_REPOSITORY'], package=package, profile=profile, versions=sorted(versions))
    require(hashlib.sha256(json.dumps(intent, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == batch_id)
    os.chdir(root)
    require(run('git', 'rev-parse', 'HEAD') == expected)
    require(not run('git', 'status', '--porcelain', '--untracked-files=no'))
    opt_in = tomllib.loads((root / '.ryro-bot.toml').read_text())
    require(opt_in == dict(schema=1, enabled=True, policy='syrox-pkgs-v1', policy_revision=revision))
    before = tomllib.loads((root / 'catalog.toml').read_text())
    for version in versions:
        # Only this fixed engine command runs; comment bodies and shell text are never accepted.
        subprocess.run([cli, 'catalog', 'add', str(root), package, version], check=True)
    after = tomllib.loads((root / 'catalog.toml').read_text())
    require(before['defaults'] == after['defaults'])
    require({k: v for k, v in before.items() if k != 'releases'} == {k: v for k, v in after.items() if k != 'releases'})
    for command in [('generate', '--check'), ('check',), ('lock', '--check')]:
        subprocess.run([cli, 'catalog', command[0], str(root), *command[1:]], check=True)
    # Include new untracked package/change files without staging credentials or build products.
    paths = set(run('git', 'diff', '--name-only', expected).splitlines())
    paths.update(run('git', 'ls-files', '--others', '--exclude-standard', '--', 'recipes', 'changes').splitlines())
    require(1 <= len(paths) <= 100)
    files, total = [], 0
    for path in sorted(paths):
        require(re.fullmatch(r'[A-Za-z0-9_./+-]+', path) and '..' not in Path(path).parts)
        require(path in ('catalog.toml', 'Catalog.lock', 'Syrox.lock') or path.startswith(f'recipes/packages/{package}/') or path.startswith('changes/'))
        file = root / path
        require(file.is_file() and not file.is_symlink() and file.stat().st_size <= 4194304)
        content = file.read_bytes()
        total += len(content)
        require(total <= 6 * 1024 * 1024)
        old = subprocess.run(['git', 'rev-parse', '--verify', expected + ':' + path], capture_output=True, text=True)
        files.append(dict(path=path, beforeBlob=old.stdout.strip() if old.returncode == 0 else None,
                          content=base64.b64encode(content).decode(), sha256=hashlib.sha256(content).hexdigest()))
    require(all(path in paths for path in ('catalog.toml', 'Catalog.lock', 'Syrox.lock')))
    document = dict(schema=1, batchId=batch_id, repositoryId=int(env['GITHUB_REPOSITORY_ID']), baseSha=expected,
                    policyRevision=revision, runId=int(env['GITHUB_RUN_ID']), runAttempt=int(env['GITHUB_RUN_ATTEMPT']),
                    defaultsBefore=before['defaults'], files=files)
    with output.open('x') as stream:
        json.dump(document, stream, sort_keys=True, separators=(',', ':'))
        stream.write('\n')


if __name__ == '__main__':
    import sys
    prepare(*sys.argv[1:])
