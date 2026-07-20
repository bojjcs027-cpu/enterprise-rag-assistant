"""Regression tests for the production-audit fixes."""

import numpy as np
import pytest

from src import database
from src.chain import SemanticCache


# ---------------------------------------------------------------------------
# Chat history: most recent N, chronological order
# ---------------------------------------------------------------------------

class TestChatHistory:
    @pytest.fixture(autouse=True)
    def tmp_db(self, tmp_path, monkeypatch):
        monkeypatch.setattr(database, "DB_PATH", tmp_path / "chat.db")
        database.init_db()

    def test_returns_most_recent_messages_in_order(self):
        for i in range(10):
            database.save_message("s1", "user", f"msg-{i}")
        history = database.get_chat_history("s1", limit=4)
        assert [m["content"] for m in history] == ["msg-6", "msg-7", "msg-8", "msg-9"]

    def test_sessions_are_isolated(self):
        database.save_message("s1", "user", "mine")
        database.save_message("s2", "user", "theirs")
        history = database.get_chat_history("s1", limit=50)
        assert [m["content"] for m in history] == ["mine"]

    def test_empty_session_returns_empty_list(self):
        assert database.get_chat_history("nobody") == []


# ---------------------------------------------------------------------------
# Semantic cache: bounded size + index-version invalidation
# ---------------------------------------------------------------------------

@pytest.fixture()
def cache(tmp_path):
    c = SemanticCache()
    c.cache_file = tmp_path / "cache.pkl"
    c.cache = []
    return c


def _entry(i: int):
    vec = np.zeros(8)
    vec[i % 8] = 1.0
    return list(vec), {"answer": f"a{i}"}


class TestSemanticCache:
    def test_add_is_bounded(self, cache, monkeypatch):
        monkeypatch.setattr(SemanticCache, "MAX_ENTRIES", 5)
        for i in range(9):
            cache.add(*_entry(i))
        assert len(cache.cache) == 5
        # Oldest entries evicted, newest kept
        assert cache.cache[-1]["payload"]["answer"] == "a8"

    def test_clear_empties_memory_and_disk(self, cache):
        cache.add(*_entry(0))
        assert cache.cache_file.exists()
        cache.clear()
        assert cache.cache == []
        reloaded = SemanticCache()
        reloaded.cache_file = cache.cache_file
        reloaded.cache = []
        reloaded.load()
        assert reloaded.cache == []

    def test_sync_index_version_sets_baseline_without_clearing(self, cache):
        cache.add(*_entry(0))
        cache.sync_index_version(3)
        assert len(cache.cache) == 1

    def test_sync_index_version_clears_on_change(self, cache):
        cache.sync_index_version(1)
        cache.add(*_entry(0))
        cache.sync_index_version(2)
        assert cache.cache == []
        assert cache.index_version == 2


# ---------------------------------------------------------------------------
# Legacy /api/documents endpoints are gone (superseded by /api/library)
# ---------------------------------------------------------------------------

class TestLegacyEndpointsRemoved:
    def test_api_documents_routes_absent(self):
        from src.app import app
        paths = set(app.openapi()["paths"].keys())
        assert "/api/documents" not in paths
        assert "/api/documents/upload" not in paths
        assert "/api/documents/{filename}" not in paths
        # The library replacement is present
        assert any(p.startswith("/api/library") for p in paths)
