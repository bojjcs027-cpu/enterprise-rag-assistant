"""Tests that CORS is an explicit allow-list driven by config, not a wildcard."""

import pytest
from fastapi.testclient import TestClient

from src import config
from src.app import app


@pytest.fixture()
def client():
    return TestClient(app)


class TestCORS:
    def test_allowed_origin_gets_cors_headers(self, client):
        origin = config.CORS_ORIGINS[0]
        resp = client.options(
            "/api/health",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == origin
        assert resp.headers.get("access-control-allow-credentials") == "true"

    def test_unknown_origin_rejected(self, client):
        resp = client.options(
            "/api/health",
            headers={
                "Origin": "https://evil.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        # Starlette answers preflight from disallowed origins with 400 and
        # no allow-origin header.
        assert resp.headers.get("access-control-allow-origin") != "https://evil.example.com"
        assert resp.status_code == 400

    def test_no_wildcard_configured(self):
        assert "*" not in config.CORS_ORIGINS
