import pytest
from fastapi.testclient import TestClient

from app.main import create_app

TOKEN = "t" * 40
HDR = {"X-Engine-Token": TOKEN}


@pytest.fixture
def client():
    return TestClient(create_app(TOKEN))


def payload():
    return {
        "bbt": [{"day": "2025-03-01", "temp_c": 36.5}],
        "hormones": [{"day": "2025-03-02", "lh_miu_ml": 26.0}],
        "mucus": [{"day": "2025-03-03", "score": 3}],
    }


def test_healthz_needs_no_token(client):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_analyze_requires_valid_token(client):
    assert client.post("/v1/analyze", json=payload()).status_code == 401
    assert client.post("/v1/analyze", json=payload(), headers={"X-Engine-Token": "x"}).status_code == 401


def test_analyze_returns_versioned_deterministic_result(client):
    a = client.post("/v1/analyze", json=payload(), headers=HDR)
    assert a.status_code == 200
    body = a.json()
    assert body["algorithm_version"].startswith("biochem-")
    assert [d["status"] for d in body["days"]] == ["INSUFFICIENT_DATA", "PEAK", "PEAK"]  # day 3: within 1 day after the LH surge
    b = client.post("/v1/analyze", json=payload(), headers=HDR).json()
    assert a.json() == b


def test_input_hash_ignores_ordering_but_not_content(client):
    p = payload()
    p["mucus"].append({"day": "2025-03-04", "score": 0})
    q = {**p, "mucus": list(reversed(p["mucus"]))}
    h1 = client.post("/v1/analyze", json=p, headers=HDR).json()["input_hash"]
    h2 = client.post("/v1/analyze", json=q, headers=HDR).json()["input_hash"]
    p["mucus"][0]["score"] = 2
    h3 = client.post("/v1/analyze", json=p, headers=HDR).json()["input_hash"]
    assert h1 == h2 != h3


def test_unknown_fields_and_nan_are_rejected(client):
    assert client.post("/v1/analyze", json={**payload(), "name": "x"}, headers=HDR).status_code == 422
    bad = payload()
    bad["bbt"][0]["temp_c"] = "NaN"
    assert client.post("/v1/analyze", json=bad, headers=HDR).status_code == 422


def test_span_over_one_year_is_422(client):
    p = {"bbt": [{"day": "2024-01-01", "temp_c": 36.5}, {"day": "2025-06-01", "temp_c": 36.5}]}
    assert client.post("/v1/analyze", json=p, headers=HDR).status_code == 422


def test_empty_request_is_valid(client):
    r = client.post("/v1/analyze", json={}, headers=HDR)
    assert r.status_code == 200 and r.json()["days"] == []


def test_weak_or_missing_token_config_fails_fast(monkeypatch):
    with pytest.raises(RuntimeError):
        create_app("short")
    monkeypatch.delenv("ENGINE_TOKEN", raising=False)
    with pytest.raises(RuntimeError):
        create_app()
    monkeypatch.setenv("ENGINE_TOKEN", TOKEN)
    assert TestClient(create_app()).get("/healthz").status_code == 200
