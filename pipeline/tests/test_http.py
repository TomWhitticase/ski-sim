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


JSON_BODY = b'{"elements": []}'


class Recorder(BaseHTTPRequestHandler):
    """Records the last User-Agent; serves JSON, or 429 with a Retry-After on demand."""

    last_user_agent: str | None = None
    retry_after: str | None = None

    def _reply(self):
        type(self).last_user_agent = self.headers.get("User-Agent")
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        if type(self).retry_after is not None:
            self.send_response(429)
            self.send_header("Retry-After", type(self).retry_after)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(JSON_BODY)))
        self.end_headers()
        self.wfile.write(JSON_BODY)

    do_GET = _reply  # noqa: N815
    do_POST = _reply  # noqa: N815

    def log_message(self, *args):
        pass


@pytest.fixture
def recorder():
    Recorder.last_user_agent = None
    Recorder.retry_after = None
    srv = HTTPServer(("127.0.0.1", 0), Recorder)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/api"
    srv.shutdown()


def test_fetch_sends_a_descriptive_user_agent(recorder):
    body = http.fetch(recorder, data=b"data=x", expect_content_type="application/json")
    assert body == JSON_BODY
    ua = Recorder.last_user_agent
    assert ua.startswith("ski-sim-pipeline/")
    assert "github.com/TomWhitticase/ski-sim" in ua


def test_download_sends_the_same_user_agent(recorder, tmp_path):
    http.download(recorder, tmp_path / "x.json")
    assert Recorder.last_user_agent.startswith("ski-sim-pipeline/")


def test_fetch_raises_rate_limited_with_retry_after(recorder):
    Recorder.retry_after = "17"
    with pytest.raises(http.RateLimited) as exc:
        http.fetch(recorder, data=b"data=x")
    assert exc.value.retry_after == 17.0


def test_parse_retry_after():
    assert http.parse_retry_after("30") == 30.0
    assert http.parse_retry_after(None) is None
    assert http.parse_retry_after("not a number") is None
    # An HTTP date in the past clamps to zero rather than going negative.
    assert http.parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT") == 0.0
