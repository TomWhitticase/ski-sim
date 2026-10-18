"""Cached, atomic HTTP downloads for source datasets."""

from __future__ import annotations

import logging
import time
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

USER_AGENT = "ski-sim-pipeline/0.1"


class NotFound(Exception):
    pass


def download(
    url: str,
    dest: Path,
    expect_content_type: str | None = None,
    retries: int = 4,
    data: bytes | None = None,
) -> Path:
    """Download `url` to `dest` unless it is already cached. Raises NotFound on HTTP 404.

    Passing `data` sends a form-encoded POST instead of a GET.
    """
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})

    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                content_type = response.headers.get("Content-Type", "")
                if expect_content_type and not content_type.startswith(expect_content_type):
                    body = response.read(500).decode(errors="replace")
                    raise RuntimeError(f"Unexpected {content_type!r} from {url}: {body}")
                with tmp.open("wb") as f:
                    while chunk := response.read(1 << 20):
                        f.write(chunk)
            tmp.replace(dest)
            return dest
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise NotFound(url) from e
            if attempt == retries - 1:
                raise
            log.warning("HTTP %s for %s, retrying", e.code, url)
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
            log.warning("Network error for %s, retrying", url)
        time.sleep(2**attempt * 5)
    raise AssertionError("unreachable")
