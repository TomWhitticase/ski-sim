import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from ski_sim_pipeline.sources import http

BODY = b"x" * 10_000


class Flaky(BaseHTTPRequestHandler):
    """Drops the connection half way through the body on the first request."""

    requests = 0

    def do_GET(self):  # noqa: N802
        type(self).requests += 1
        self.send_response(200)
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY if type(self).requests > 1 else BODY[:3000])

    def log_message(self, *args):
        pass


@pytest.fixture
def server():
    Flaky.requests = 0
    srv = HTTPServer(("127.0.0.1", 0), Flaky)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/tile"
    srv.shutdown()


def test_a_truncated_body_is_retried_not_cached(server, tmp_path, monkeypatch):
    monkeypatch.setattr(http.time, "sleep", lambda s: None)
    dest = http.download(server, tmp_path / "tile.tif")
    assert dest.read_bytes() == BODY
    assert Flaky.requests == 2


def test_a_body_that_stays_truncated_fails_without_a_cached_file(server, tmp_path, monkeypatch):
    monkeypatch.setattr(http.time, "sleep", lambda s: None)
    with pytest.raises(http.TruncatedDownload):
        http.download(server, tmp_path / "tile.tif", retries=1)
    assert not (tmp_path / "tile.tif").exists()
