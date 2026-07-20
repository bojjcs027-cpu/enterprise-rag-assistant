"""
Unit tests for Phase 4: retrieval instrumentation, scoring, and caches.

Heavy models are faked; the logic under test (score math, cache behaviour,
metrics assembly) runs for real.
"""

import math

import pytest
from langchain_core.documents import Document

from src.chain import RAGChain
from src.retriever import HybridRetriever


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeEmbeddings:
    """Deterministic 3-dim embeddings; counts calls to prove caching."""
    def __init__(self):
        self.calls = 0

    def embed_query(self, text):
        self.calls += 1
        h = abs(hash(text))
        return [(h % 97) / 97.0, (h % 89) / 89.0, (h % 83) / 83.0]


class FakeVectorStore:
    """Returns (doc, L2-distance) pairs like FAISS."""
    def __init__(self, docs):
        self.docs = docs

    def similarity_search_with_score_by_vector(self, embedding, k):
        return [(d, 0.5 + i * 0.25) for i, d in enumerate(self.docs[:k])]


class FakeBM25Vectorizer:
    def __init__(self, scores):
        self._scores = scores

    def get_scores(self, tokens):
        return list(self._scores)


class FakeBM25Retriever:
    def __init__(self, docs, scores):
        self.docs = docs
        self.vectorizer = FakeBM25Vectorizer(scores)
        self.preprocess_func = lambda q: q.lower().split()
        self.k = len(docs)


def make_docs(n):
    return [
        Document(page_content=f"content {i}",
                 metadata={"chunk_id": f"doc.md_{i}", "source": "doc.md",
                           "section": f"S{i}", "page": 1})
        for i in range(n)
    ]


@pytest.fixture()
def fake_retriever():
    r = HybridRetriever()
    docs = make_docs(4)
    r.embeddings = FakeEmbeddings()
    r.vector_store = FakeVectorStore(docs)
    r.bm25_retriever = FakeBM25Retriever(docs, [3.0, 9.0, 1.0, 5.0])
    r.all_documents = docs
    r._initialized = True
    return r


# ---------------------------------------------------------------------------
# retrieve_detailed: real scores
# ---------------------------------------------------------------------------

class TestRetrieveDetailed:
    def test_bm25_scores_sorted_and_attached(self, fake_retriever):
        out = fake_retriever.retrieve_detailed("some query", top_k=3)
        scores = [it["bm25_score"] for it in out["bm25"]]
        assert scores == [9.0, 5.0, 3.0]  # descending Okapi scores
        assert out["bm25"][0]["doc"].metadata["chunk_id"] == "doc.md_1"

    def test_vector_similarity_derived_from_distance(self, fake_retriever):
        out = fake_retriever.retrieve_detailed("q", top_k=2)
        first = out["vector"][0]
        assert first["vector_distance"] == 0.5
        assert first["vector_similarity"] == pytest.approx(1 / 1.5)

    def test_fused_items_carry_both_scores(self, fake_retriever):
        out = fake_retriever.retrieve_detailed("q", top_k=4)
        for item in out["fused"]:
            # every doc appears in both fakes, so both scores must be present
            assert item["bm25_score"] is not None
            assert item["vector_similarity"] is not None
            assert item["score"] > 0  # RRF score

    def test_timings_present_and_nonnegative(self, fake_retriever):
        out = fake_retriever.retrieve_detailed("q", top_k=2)
        t = out["timings_ms"]
        assert set(t) == {"bm25", "vector", "fusion", "total"}
        assert all(v >= 0 for v in t.values())

    def test_retrieve_wrapper_matches_fused(self, fake_retriever):
        fused = fake_retriever.retrieve("q", top_k=3)
        detail = fake_retriever.retrieve_detailed("q", top_k=3)
        assert [f["doc"].metadata["chunk_id"] for f in fused] == \
               [f["doc"].metadata["chunk_id"] for f in detail["fused"]]


# ---------------------------------------------------------------------------
# Caches
# ---------------------------------------------------------------------------

class TestCaches:
    def test_embed_query_cached_avoids_recompute(self, fake_retriever):
        v1 = fake_retriever.embed_query_cached("hello world")
        v2 = fake_retriever.embed_query_cached("hello world")
        assert v1 == v2
        assert fake_retriever.embeddings.calls == 1

    def test_retrieval_cache_hits_on_repeat(self, fake_retriever):
        first = fake_retriever.retrieve_detailed("repeat me", top_k=2)
        second = fake_retriever.retrieve_detailed("repeat me", top_k=2)
        assert first["from_cache"] is False
        assert second["from_cache"] is True

    def test_retrieval_cache_key_includes_top_k(self, fake_retriever):
        fake_retriever.retrieve_detailed("q", top_k=2)
        other = fake_retriever.retrieve_detailed("q", top_k=3)
        assert other["from_cache"] is False

    def test_index_version_bump_invalidates_cache(self, fake_retriever):
        fake_retriever.retrieve_detailed("q", top_k=2)
        # simulate what reindex() does
        fake_retriever.index_version += 1
        fake_retriever._retrieval_cache.clear()
        again = fake_retriever.retrieve_detailed("q", top_k=2)
        assert again["from_cache"] is False


# ---------------------------------------------------------------------------
# Chain formatting: confidence + final rank
# ---------------------------------------------------------------------------

class TestChainFormatting:
    def test_sigmoid_bounds_and_symmetry(self):
        assert RAGChain._sigmoid(0) == pytest.approx(0.5)
        assert RAGChain._sigmoid(10) > 0.999
        assert RAGChain._sigmoid(-10) < 0.001
        # extreme logits must not overflow
        assert RAGChain._sigmoid(-1000) == pytest.approx(0.0, abs=1e-9)
        assert RAGChain._sigmoid(1000) == pytest.approx(1.0)

    def test_reranked_formatting_includes_confidence_and_rank(self):
        docs = make_docs(2)
        items = [
            {"doc": docs[0], "vector_rank": 1, "bm25_rank": 2, "score": 0.03,
             "bm25_score": 8.0, "vector_similarity": 0.6, "vector_distance": 0.66,
             "rerank_score": 4.0},
            {"doc": docs[1], "vector_rank": 2, "bm25_rank": 1, "score": 0.02,
             "bm25_score": 9.0, "vector_similarity": 0.5, "vector_distance": 1.0,
             "rerank_score": -2.0},
        ]
        out = RAGChain._format_reranked_results(items)
        assert out[0]["final_rank"] == 1 and out[1]["final_rank"] == 2
        assert out[0]["confidence"] == pytest.approx(1 / (1 + math.exp(-4.0)))
        assert out[0]["bm25_score"] == 8.0
        assert out[0]["vector_similarity"] == 0.6
        assert out[0]["chunk_id"] == "doc.md_0"
