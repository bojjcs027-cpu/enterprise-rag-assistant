"""Tests for Prometheus instrumentation."""

import pytest
from fastapi.testclient import TestClient

from src import metrics
from src.app import app


@pytest.fixture()
def client():
    return TestClient(app)


class TestMetricsEndpoint:
    def test_metrics_exposed_without_auth(self, client):
        resp = client.get("/metrics")
        assert resp.status_code == 200
        assert "rag_http_requests_total" in resp.text

    def test_requests_are_counted_with_route_template(self, client):
        client.get("/api/health")
        resp = client.get("/metrics")
        assert 'path="/api/health"' in resp.text

    def test_pipeline_metrics_registered(self, client):
        body = client.get("/metrics").text
        for name in ("rag_retrieval_seconds", "rag_rerank_seconds",
                     "rag_llm_seconds", "rag_semantic_cache_events_total",
                     "rag_uploads_total", "rag_active_users",
                     "rag_active_conversations"):
            assert name in body


class TestHelpers:
    def test_observe_pipeline_counts_cache_hit(self):
        before = metrics.SEMANTIC_CACHE_EVENTS.labels(result="hit")._value.get()
        metrics.observe_pipeline({}, cache_hit=True,
                                 retrieval_cache_hit=False, provider="local")
        after = metrics.SEMANTIC_CACHE_EVENTS.labels(result="hit")._value.get()
        assert after == before + 1

    def test_observe_pipeline_records_stage_latencies(self):
        h = metrics.LLM_LATENCY
        before = h._sum.get()
        metrics.observe_pipeline(
            {"retrieval": 100.0, "rerank": 50.0, "llm": 2000.0},
            cache_hit=False, retrieval_cache_hit=False, provider="local")
        assert h._sum.get() == pytest.approx(before + 2.0)

    def test_activity_gauges_track_distinct_users(self):
        metrics.record_chat_activity(101, "user:101")
        metrics.record_chat_activity(102, "user:102")
        metrics.record_chat_activity(101, "user:101")  # repeat, not double-counted
        assert metrics.ACTIVE_USERS._value.get() >= 2
        assert metrics.ACTIVE_CONVERSATIONS._value.get() >= 2
