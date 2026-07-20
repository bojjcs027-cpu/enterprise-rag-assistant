"""Tests for the optional Redis backends and their in-memory fallbacks."""

import numpy as np
import pytest
import fakeredis

from src import redis_backend
from src.auth.rate_limit import SlidingWindowLimiter
from src.chain import SemanticCache


@pytest.fixture()
def fake_redis(monkeypatch):
    r = fakeredis.FakeRedis()
    monkeypatch.setattr(redis_backend, "get_redis", lambda: r)
    # Consumers import the module, not the function, so patching the module
    # attribute covers every call site.
    return r


@pytest.fixture()
def no_redis(monkeypatch):
    monkeypatch.setattr(redis_backend, "get_redis", lambda: None)


# ---------------------------------------------------------------------------
# Connection handling
# ---------------------------------------------------------------------------

class TestConnection:
    def test_disabled_without_url(self, monkeypatch):
        from src import config
        monkeypatch.setattr(config, "REDIS_URL", "")
        redis_backend.reset_for_tests()
        assert redis_backend.get_redis() is None

    def test_unreachable_falls_back_to_none(self, monkeypatch):
        from src import config
        monkeypatch.setattr(config, "REDIS_URL", "redis://127.0.0.1:1/0")
        redis_backend.reset_for_tests()
        assert redis_backend.get_redis() is None
        redis_backend.reset_for_tests()


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------

class TestRedisRateLimiter:
    def test_redis_window_blocks_after_max(self, fake_redis):
        limiter = SlidingWindowLimiter(max_requests=3, window_seconds=60)
        assert limiter.check_any("k") is None
        assert limiter.check_any("k") is None
        assert limiter.check_any("k") is None
        retry = limiter.check_any("k")
        assert retry is not None and 0 < retry <= 60

    def test_redis_keys_are_independent(self, fake_redis):
        limiter = SlidingWindowLimiter(max_requests=1, window_seconds=60)
        assert limiter.check_any("a") is None
        assert limiter.check_any("b") is None
        assert limiter.check_any("a") is not None

    def test_falls_back_to_memory_without_redis(self, no_redis):
        limiter = SlidingWindowLimiter(max_requests=2, window_seconds=60)
        assert limiter.check_any("k") is None
        assert limiter.check_any("k") is None
        assert limiter.check_any("k") is not None

    def test_falls_back_to_memory_on_redis_error(self, monkeypatch):
        class Broken:
            def pipeline(self):
                raise ConnectionError("down")
        monkeypatch.setattr(redis_backend, "get_redis", lambda: Broken())
        limiter = SlidingWindowLimiter(max_requests=1, window_seconds=60)
        assert limiter.check_any("k") is None      # memory path took the hit
        assert limiter.check_any("k") is not None  # and enforces the limit


# ---------------------------------------------------------------------------
# Semantic cache persistence
# ---------------------------------------------------------------------------

def _entry(i: int):
    vec = np.zeros(4)
    vec[i % 4] = 1.0
    return list(vec), {"answer": f"a{i}"}


class TestRedisSemanticCache:
    def test_add_persists_and_reload_restores(self, fake_redis, tmp_path):
        c = SemanticCache()
        c.cache_file = tmp_path / "cache.pkl"
        c.cache = []
        c.add(*_entry(0))
        c.add(*_entry(1))

        c2 = SemanticCache()
        c2.cache_file = tmp_path / "cache.pkl"
        assert len(c2.cache) == 2
        assert c2.cache[1]["payload"]["answer"] == "a1"
        # Nothing written to disk when Redis handles persistence
        assert not (tmp_path / "cache.pkl").exists()

    def test_clear_empties_redis(self, fake_redis, tmp_path):
        c = SemanticCache()
        c.cache_file = tmp_path / "cache.pkl"
        c.cache = []
        c.add(*_entry(0))
        c.clear()
        assert fake_redis.lrange(SemanticCache.REDIS_KEY, 0, -1) == []

    def test_file_fallback_without_redis(self, no_redis, tmp_path):
        c = SemanticCache()
        c.cache_file = tmp_path / "cache.pkl"
        c.cache = []
        c.add(*_entry(0))
        assert (tmp_path / "cache.pkl").exists()


# ---------------------------------------------------------------------------
# Retrieval cache L2
# ---------------------------------------------------------------------------

class TestRedisRetrievalCache:
    def test_l2_hit_after_l1_eviction(self, fake_redis):
        from langchain_core.documents import Document
        from src.retriever import HybridRetriever

        retr = HybridRetriever()
        retr._initialized = True  # skip model loading
        doc = Document(page_content="alpha beta", metadata={"chunk_id": "d0"})

        # Seed BM25 only (no vector store) — enough to exercise the cache path
        from langchain_community.retrievers import BM25Retriever
        retr.bm25_retriever = BM25Retriever.from_documents([doc])
        retr.all_documents = [doc]

        first = retr.retrieve_detailed("alpha", top_k=2)
        assert first["from_cache"] is False
        assert len(fake_redis.keys("rag:retrieval:*")) == 1

        # Wipe L1 — the shared L2 must still answer
        retr._retrieval_cache.clear()
        second = retr.retrieve_detailed("alpha", top_k=2)
        assert second["from_cache"] is True
