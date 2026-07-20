"""
Tests for the unauthenticated /api/health probe.

TestClient is used WITHOUT a context manager so the lifespan hook (which
loads embedding/rerank models) never runs — the endpoint must work during
warm-up too, reporting 503 until the index is ready.
"""

import pytest
from fastapi.testclient import TestClient

from src import retriever
from src.app import app


@pytest.fixture()
def client():
    return TestClient(app)


class TestHealth:
    def test_health_requires_no_auth(self, client):
        resp = client.get("/api/health")
        assert resp.status_code in (200, 503)  # never 401

    def test_health_reports_starting_before_index_ready(self, client, monkeypatch):
        monkeypatch.setattr(retriever.retriever_instance, "_initialized", False)
        resp = client.get("/api/health")
        assert resp.status_code == 503
        body = resp.json()
        assert body["status"] == "starting"
        assert body["index_ready"] is False

    def test_health_ok_when_index_ready_and_db_up(self, client, monkeypatch):
        monkeypatch.setattr(retriever.retriever_instance, "_initialized", True)
        resp = client.get("/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["index_ready"] is True
        assert body["database_ok"] is True
        assert "version" in body

    def test_health_reports_db_failure(self, client, monkeypatch):
        monkeypatch.setattr(retriever.retriever_instance, "_initialized", True)

        class BrokenEngine:
            def connect(self):
                raise RuntimeError("db down")

        from src import app as app_module
        monkeypatch.setattr(app_module, "engine", BrokenEngine())
        resp = client.get("/api/health")
        assert resp.status_code == 503
        assert resp.json()["database_ok"] is False
