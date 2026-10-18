import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).parents[1] / 'scripts/prepare.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.original = Path.cwd()

    def tearDown(self):
        os.chdir(self.original)

    def test_prepares_pinned_additions_without_write_tokens_or_default_promotion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            revision = 'b' * 40
            (root / '.ryro-bot.toml').write_text(f'schema=1\nenabled=true\npolicy="syrox-pkgs-v1"\npolicy_revision="{revision}"\n')
            (root / 'catalog.toml').write_text('schema=2\nreleases=[]\n[defaults]\nnginx="1.0.0"\n')
            for lock in ['Catalog.lock', 'Syrox.lock']:
                (root / lock).write_text('base')
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], check=True)
            base = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            cli = root / 'fake-engine'
            cli.write_text(f'''#!{sys.executable}
from pathlib import Path
import sys
if sys.argv[2] == 'add':
    root = Path(sys.argv[3])
    for lock in ['Catalog.lock', 'Syrox.lock']:
        (root / lock).write_text('new locks')
    (root / 'catalog.toml').write_text('schema=2\\n[defaults]\\nnginx="1.0.0"\\n[[releases]]\\nname="nginx"\\nversion="2.0.0"\\n')
''')
            cli.chmod(0o700)
            intent = dict(repository='ryro-hq/syrox-pkgs', package='nginx', profile='minimal', versions=['2.0.0'])
            batch = hashlib.sha256(json.dumps(intent, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            env = dict(EXPECTED_SHA=base, POLICY_REVISION=revision, BATCH_ID=batch, PACKAGE='nginx', PROFILE='minimal', VERSIONS='["2.0.0"]', GITHUB_REPOSITORY='ryro-hq/syrox-pkgs', GITHUB_REPOSITORY_ID='1', GITHUB_RUN_ID='2', GITHUB_RUN_ATTEMPT='1')
            output = root / 'prepared.json'
            module.prepare(root, output, str(cli), env)
            doc = json.loads(output.read_text())
            self.assertEqual(doc['baseSha'], base)
            self.assertEqual(doc['runId'], 2)
            self.assertEqual({file['path'] for file in doc['files']}, {'catalog.toml', 'Catalog.lock', 'Syrox.lock'})
            for file in doc['files']:
                self.assertEqual(hashlib.sha256(base64.b64decode(file['content'])).hexdigest(), file['sha256'])
            self.assertEqual(subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), base)

    def test_rejects_shell_text_and_oversized_version_batches_before_execution(self):
        env = dict(EXPECTED_SHA='a'*40, POLICY_REVISION='b'*40, BATCH_ID='c'*64, PACKAGE='nginx;touch /tmp/injected', PROFILE='minimal', VERSIONS='["2.0.0"]')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                module.prepare(directory, Path(directory)/'out', '/does/not/execute', env)


if __name__ == '__main__':
    unittest.main()
