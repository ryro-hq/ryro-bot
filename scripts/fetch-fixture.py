#!/usr/bin/env python3
"""Retrieve only the exact bytes admitted by a trusted, pinned central manifest."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


def require(condition):
    if not condition:
        raise ValueError("untrusted or incomplete preparation/fixture input")


def download(manifest, destination, opener=None):
    require(manifest['schema'] == 1 and manifest['status'] == 'available-verified')
    target = urlsplit(manifest['url'])
    require(target.scheme == 'https' and target.hostname and not target.username and not target.password and not target.fragment)
    require(target.port in (None, 443))
    require(len(manifest['sha256']) == 64 and all(c in '0123456789abcdef' for c in manifest['sha256']))
    require(0 < manifest['maximumBytes'] <= 4 * 1024 * 1024)

    class Redirects(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            new = urlsplit(newurl)
            require((new.scheme, new.hostname, new.port) == (target.scheme, target.hostname, target.port))
            require(not new.username and not new.password and not new.fragment)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    destination = Path(destination)
    require(not destination.exists() and not destination.is_symlink())
    fd, temporary = tempfile.mkstemp(prefix='.fixture-', dir=destination.parent)
    try:
        digest, size = hashlib.sha256(), 0
        with os.fdopen(fd, 'wb') as output:
            request = Request(manifest['url'], headers={'User-Agent': 'ryro-bot-fixture/1'})
            with (opener or build_opener(Redirects())).open(request, timeout=30) as response:
                while chunk := response.read(65536):
                    size += len(chunk)
                    require(size <= manifest['maximumBytes'])
                    digest.update(chunk)
                    output.write(chunk)
            require(digest.hexdigest() == manifest['sha256'])
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, destination)  # Refuse replacement, including a raced symlink.
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)


if __name__ == '__main__':
    import sys
    # The caller obtains this manifest from its reviewed SHA-pinned central checkout.
    download(json.loads(Path(sys.argv[1]).read_text()), sys.argv[2])
