"""Cached, atomic HTTP downloads for source datasets."""

from __future__ import annotations

import datetime
import email.utils
import http.client
import logging
import time
import urllib.error
import urllib.request
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

log = logging.getLogger(__name__)


def _user_agent() -> str:
    """A descriptive User-Agent, as public services (Overpass, OSM) ask for: some reject
    requests without one (overpass-api.de answers HTTP 406 instantly to a blank UA)."""
    try:
        v = version("ski-sim-pipeline")
    except PackageNotFoundError:  # running from a source tree with no install
        v = "0"
    return f"ski-sim-pipeline/{v} (+https://github.com/TomWhitticase/ski-sim)"


USER_AGENT = _user_agent()


class NotFound(Exception):
    pass


class TruncatedDownload(Exception):
    pass


class RateLimited(Exception):
    """HTTP 429 or 503. `retry_after` is the server's requested wait in seconds, if it gave one."""

    def __init__(self, url: str, retry_after: float | None = None):
        super().__init__(f"rate limited by {url}")
        self.retry_after = retry_after


def parse_retry_after(value: str | None) -> float | None:
    """A `Retry-After` header as seconds: either a number of seconds or an HTTP date."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    now = datetime.datetime.now(when.tzinfo)
    return max(0.0, (when - now).total_seconds())


def fetch(
    url: str,
    data: bytes | None = None,
    expect_content_type: str | None = None,
    timeout: float = 300,
) -> bytes:
    """A single HTTP request (a POST if `data` is given), returning the whole body in memory.

    Does no caching and no retrying: that's the caller's job. Raises NotFound (404),
    RateLimited (429/503, carrying any Retry-After), TruncatedDownload (a body short of its
    Content-Length), RuntimeError (unexpected content type) or the underlying URL/HTTP error.
    """
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            if expect_content_type and not content_type.startswith(expect_content_type):
                snippet = response.read(500).decode(errors="replace")
                raise RuntimeError(f"Unexpected {content_type!r} from {url}: {snippet}")
            expected = response.headers.get("Content-Length")
            body = response.read()
            if expected is not None and len(body) != int(expected):
                raise TruncatedDownload(f"{len(body)} of {expected} bytes from {url}")
            return body
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise NotFound(url) from e
        if e.code in (429, 503):
            raise RateLimited(url, parse_retry_after(e.headers.get("Retry-After"))) from e
        raise


def download(
    url: str,
    dest: Path,
    expect_content_type: str | None = None,
    retries: int = 4,
    data: bytes | None = None,
) -> Path:
    """Download `url` to `dest` unless it is already cached. Raises NotFound on HTTP 404.

    Passing `data` sends a form-encoded POST instead of a GET. Streams the body to a temp
    file so a large tile never sits in memory; honours a server's Retry-After on 429/503.
    """
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})

    for attempt in range(retries):
        retry_after: float | None = None
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                content_type = response.headers.get("Content-Type", "")
                if expect_content_type and not content_type.startswith(expect_content_type):
                    body = response.read(500).decode(errors="replace")
                    raise RuntimeError(f"Unexpected {content_type!r} from {url}: {body}")
                expected = response.headers.get("Content-Length")
                size = 0
                with tmp.open("wb") as f:
                    while chunk := response.read(1 << 20):
                        f.write(chunk)
                        size += len(chunk)
                # A server that drops the connection mid-body ends the stream early
                # without an error: never cache a truncated file.
                if expected is not None and size != int(expected):
                    raise TruncatedDownload(f"{size} of {expected} bytes from {url}")
            tmp.replace(dest)
            return dest
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise NotFound(url) from e
            if attempt == retries - 1:
                raise
            if e.code in (429, 503):
                retry_after = parse_retry_after(e.headers.get("Retry-After"))
            log.warning("HTTP %s for %s, retrying", e.code, url)
        except (urllib.error.URLError, http.client.HTTPException, OSError, TruncatedDownload):
            if attempt == retries - 1:
                raise
            log.warning("Network error for %s, retrying", url)
        time.sleep(retry_after if retry_after is not None else 2**attempt * 5)
    raise AssertionError("unreachable")
