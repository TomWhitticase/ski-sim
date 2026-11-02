import json

import pytest

from ski_sim_pipeline.sources import http, osm

URLS = ("https://a.example/api", "https://b.example/api")


def test_strip_null_vertices_drops_nulls_from_ways_and_relation_members():
    elements = [
        {"type": "way", "geometry": [{"lat": 1, "lon": 2}, None, {"lat": 3, "lon": 4}]},
        {
            "type": "relation",
            "members": [{"geometry": [{"lat": 5, "lon": 6}, None, {"lat": 7}]}],
        },
        {"type": "node", "lat": 8, "lon": 9},
    ]
    osm.strip_null_vertices(elements)
    assert elements[0]["geometry"] == [{"lat": 1, "lon": 2}, {"lat": 3, "lon": 4}]
    assert elements[1]["members"][0]["geometry"] == [{"lat": 5, "lon": 6}]  # {"lat": 7} dropped
    assert elements[2] == {"type": "node", "lat": 8, "lon": 9}  # a node is untouched


def _scripted_fetch(responses):
    """A fake http.fetch returning/raising the next scripted item per call, recording urls."""
    calls = []

    def fetch(url, data=None, expect_content_type=None, timeout=None):
        calls.append(url)
        item = responses[len(calls) - 1]
        if isinstance(item, Exception):
            raise item
        return item

    fetch.calls = calls
    return fetch


def test_mirror_fallthrough_returns_the_first_mirror_that_works(monkeypatch):
    fetch = _scripted_fetch([RuntimeError("502"), b'{"elements": []}'])
    monkeypatch.setattr(osm.http, "fetch", fetch)
    sleeps: list[float] = []
    raw = osm._fetch_overpass(
        "q", urls=URLS, budget=600, sleep=sleeps.append, clock=lambda: 0.0, jitter=lambda: 0.5
    )
    assert raw == b'{"elements": []}'
    assert fetch.calls == list(URLS)  # tried the first, fell through to the second
    assert sleeps == []  # both tried in one round, so no backoff


def test_backoff_grows_exponentially_between_rounds(monkeypatch):
    # One mirror, failing twice then succeeding: two backoffs, 5 s then 10 s (jitter ×1).
    fetch = _scripted_fetch([RuntimeError("502"), RuntimeError("502"), b'{"elements": []}'])
    monkeypatch.setattr(osm.http, "fetch", fetch)
    sleeps: list[float] = []
    osm._fetch_overpass(
        "q",
        urls=("https://a.example/api",),
        budget=10_000,
        sleep=sleeps.append,
        clock=lambda: 0.0,
        jitter=lambda: 0.5,
    )
    assert sleeps == [5.0, 10.0]


def test_retry_after_is_honoured_over_the_backoff(monkeypatch):
    fetch = _scripted_fetch([http.RateLimited("a", retry_after=30.0), b'{"elements": []}'])
    monkeypatch.setattr(osm.http, "fetch", fetch)
    sleeps: list[float] = []
    osm._fetch_overpass(
        "q",
        urls=("https://a.example/api",),
        budget=10_000,
        sleep=sleeps.append,
        clock=lambda: 0.0,
        jitter=lambda: 0.5,
    )
    assert sleeps == [30.0]  # max(Retry-After 30, backoff 5) × 1.0


def test_gives_up_when_the_budget_runs_out(monkeypatch):
    fetch = _scripted_fetch([RuntimeError("502")] * 10)
    monkeypatch.setattr(osm.http, "fetch", fetch)
    sleeps: list[float] = []
    with pytest.raises(RuntimeError, match="budget"):
        osm._fetch_overpass(
            "q",
            urls=("https://a.example/api",),
            budget=1,
            sleep=sleeps.append,
            clock=lambda: 0.0,
            jitter=lambda: 0.5,
        )
    assert sleeps == []  # the first wait would overrun the 1 s budget, so never slept


def test_overpass_urls_override_from_env(monkeypatch):
    monkeypatch.setenv("OVERPASS_URLS", "https://one/api , https://two/api")
    assert osm._overpass_urls() == ("https://one/api", "https://two/api")
    monkeypatch.delenv("OVERPASS_URLS")
    assert osm._overpass_urls() == osm.DEFAULT_OVERPASS_URLS


def test_query_caches_a_sanitised_response_and_resumes_from_it(monkeypatch, tmp_path):
    body = json.dumps(
        {"elements": [{"type": "way", "geometry": [{"lat": 1, "lon": 2}, None]}]}
    ).encode()
    fetch = _scripted_fetch([body])
    monkeypatch.setattr(osm.http, "fetch", fetch)

    elements = osm._query("some query", tmp_path, "lifts")
    assert elements == [{"type": "way", "geometry": [{"lat": 1, "lon": 2}]}]  # null stripped

    cached = list((tmp_path / "osm").glob("overpass-*.json"))
    assert len(cached) == 1
    assert None not in json.loads(cached[0].read_text())["elements"][0]["geometry"]

    # A re-run resumes from the cache without touching the network.
    again = osm._query("some query", tmp_path, "lifts")
    assert again == elements
    assert len(fetch.calls) == 1


def test_query_never_caches_a_failed_fetch(monkeypatch, tmp_path):
    monkeypatch.setenv("OVERPASS_BUDGET_S", "1")
    monkeypatch.setattr(osm.http, "fetch", _scripted_fetch([RuntimeError("502")] * 10))
    monkeypatch.setattr(osm.random, "random", lambda: 0.0)
    with pytest.raises(RuntimeError):
        osm._query("q", tmp_path, "lifts")
    assert not list((tmp_path / "osm").glob("*.json"))
    assert not list((tmp_path / "osm").glob("*.part")) if (tmp_path / "osm").exists() else True


def test_query_never_caches_an_invalid_or_empty_response(monkeypatch, tmp_path):
    monkeypatch.setattr(osm.http, "fetch", _scripted_fetch([b"not json"]))
    with pytest.raises(RuntimeError):
        osm._query("q", tmp_path, "lifts")
    assert not list(tmp_path.glob("osm/*.json"))

    monkeypatch.setattr(osm.http, "fetch", _scripted_fetch([b'{"version": 0.6}']))
    with pytest.raises(RuntimeError, match="no elements"):
        osm._query("q", tmp_path, "lifts")
    assert not list(tmp_path.glob("osm/*.json"))
