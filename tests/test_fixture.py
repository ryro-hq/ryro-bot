import hashlib
import importlib.util
from io import BytesIO
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('fetch_fixture', Path(__file__).parents[1] / 'scripts/fetch-fixture.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FixtureTests(unittest.TestCase):
    def manifest(self, data):
        return dict(schema=1, status='available-verified', url='https://fixtures.example/fixture', sha256=hashlib.sha256(data).hexdigest(), maximumBytes=8)

    def opener(self, data):
        class Opener:
            def open(self, request, timeout):
                return BytesIO(data)
        return Opener()

    def test_retrieves_identical_bytes_without_overwriting(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'fixture'
            module.download(self.manifest(b'bytes'), path, self.opener(b'bytes'))
            self.assertEqual(path.read_bytes(), b'bytes')
            with self.assertRaises(ValueError):
                module.download(self.manifest(b'bytes'), path, self.opener(b'bytes'))

    def test_refuses_pending_tampered_and_oversized_bytes(self):
        for data, status in [(b'wrong', 'available-verified'), (b'0123456789', 'available-verified'), (b'bytes', 'distribution-pending')]:
            with self.subTest(data=data, status=status), tempfile.TemporaryDirectory() as temporary:
                manifest = self.manifest(b'bytes') | dict(status=status)
                path = Path(temporary) / 'fixture'
                with self.assertRaises(ValueError):
                    module.download(manifest, path, self.opener(data))
                self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
