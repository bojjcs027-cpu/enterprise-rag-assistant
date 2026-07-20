"""
Prometheus instrumentation.

All metric objects live here; the rest of the codebase calls the small
helper functions so instrumentation stays one line at each call site.
Exposed at GET /metrics (see src/app.py). Metrics are per-process — when
running multiple workers, scrape each or use prometheus_client's
multiprocess mode.
"""

import threading
import time

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

HTTP_REQUESTS = Counter(
    "rag_http_requests_total",
    "HTTP requests served",
    ["method", "path", "status"],
)
HTTP_ERRORS = Counter(
    "rag_http_errors_total",
    "HTTP responses with status >= 500",
    ["method", "path"],
)
HTTP_LATENCY = Histogram(
    "rag_http_request_seconds",
    "HTTP request duration",
    ["method", "path"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
)

# ---------------------------------------------------------------------------
# RAG pipeline
# ---------------------------------------------------------------------------

RETRIEVAL_LATENCY = Histogram(
    "rag_retrieval_seconds", "Hybrid retrieval (BM25+FAISS+RRF) duration",
    buckets=(0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5),
)
RERANK_LATENCY = Histogram(
    "rag_rerank_seconds", "Cross-encoder rerank duration",
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5),
)
LLM_LATENCY = Histogram(
    "rag_llm_seconds", "LLM generation duration",
    buckets=(0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120),
)
SEMANTIC_CACHE_EVENTS = Counter(
    "rag_semantic_cache_events_total",
    "Semantic answer-cache lookups by result",
    ["result"],  # hit | miss
)
RETRIEVAL_CACHE_EVENTS = Counter(
    "rag_retrieval_cache_events_total",
    "Retrieval-cache lookups by result",
    ["result"],  # hit | miss
)
CHAT_REQUESTS = Counter(
    "rag_chat_requests_total", "Chat questions answered", ["provider"],
)
UPLOADS = Counter(
    "rag_uploads_total", "Documents accepted for indexing",
)

# ---------------------------------------------------------------------------
# Activity gauges (sliding 5-minute window)
# ---------------------------------------------------------------------------

ACTIVE_USERS = Gauge(
    "rag_active_users", "Distinct users who sent a chat in the last 5 minutes",
)
ACTIVE_CONVERSATIONS = Gauge(
    "rag_active_conversations",
    "Distinct chat sessions active in the last 5 minutes",
)

_ACTIVITY_WINDOW_SECONDS = 300
_activity_lock = threading.Lock()
_user_last_seen: dict[int, float] = {}
_session_last_seen: dict[str, float] = {}


def record_chat_activity(user_id: int, session_id: str) -> None:
    """Marks a user/session as active and refreshes both gauges."""
    now = time.monotonic()
    cutoff = now - _ACTIVITY_WINDOW_SECONDS
    with _activity_lock:
        _user_last_seen[user_id] = now
        _session_last_seen[session_id] = now
        for d in (_user_last_seen, _session_last_seen):
            stale = [k for k, ts in d.items() if ts <= cutoff]
            for k in stale:
                del d[k]
        ACTIVE_USERS.set(len(_user_last_seen))
        ACTIVE_CONVERSATIONS.set(len(_session_last_seen))


def observe_pipeline(timings_ms: dict, cache_hit: bool,
                     retrieval_cache_hit: bool, provider: str) -> None:
    """Records one chat request's stage timings and cache outcomes.
    timings_ms is the same dict the API returns in metrics.timings_ms."""
    CHAT_REQUESTS.labels(provider=provider).inc()
    SEMANTIC_CACHE_EVENTS.labels(result="hit" if cache_hit else "miss").inc()
    if cache_hit:
        return  # no pipeline stages ran
    RETRIEVAL_CACHE_EVENTS.labels(
        result="hit" if retrieval_cache_hit else "miss").inc()
    if "retrieval" in timings_ms:
        RETRIEVAL_LATENCY.observe(timings_ms["retrieval"] / 1000.0)
    if "rerank" in timings_ms:
        RERANK_LATENCY.observe(timings_ms["rerank"] / 1000.0)
    if "llm" in timings_ms:
        LLM_LATENCY.observe(timings_ms["llm"] / 1000.0)


def render() -> tuple[bytes, str]:
    """Returns (payload, content_type) for the /metrics endpoint."""
    return generate_latest(), CONTENT_TYPE_LATEST
