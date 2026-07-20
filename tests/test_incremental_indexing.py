"""
Tests for incremental indexing (add/remove without a full rebuild).

Uses a deterministic fake embedder so FAISS runs for real (faiss-cpu),
with no model downloads and millisecond runtimes.
"""

import hashlib

import numpy as np
import pytest
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings
from langchain_community.vectorstores import FAISS
from langchain_community.retrievers import BM25Retriever

from src import document_loader
from src.retriever import HybridRetriever


class FakeEmbeddings(Embeddings):
    """Deterministic 16-dim embeddings derived from a text hash."""

    def _vec(self, text: str):
        seed = int.from_bytes(hashlib.sha256(text.encode()).digest()[:4], "big")
        rng = np.random.default_rng(seed)
        v = rng.normal(size=16)
        return (v / np.linalg.norm(v)).tolist()

    def embed_documents(self, texts):
        return [self._vec(t) for t in texts]

    def embed_query(self, text):
        return self._vec(text)


def make_doc(source: str, i: int, text: str) -> Document:
    return Document(
        page_content=text,
        metadata={"source": source, "section": "General",
                  "chunk_id": f"{source}_{i}", "page": 1},
    )


@pytest.fixture()
def retriever(tmp_path, monkeypatch):
    """A HybridRetriever with a real FAISS store over two seed files,
    persisting into tmp_path."""
    from src import config
    monkeypatch.setattr(config, "VECTOR_DB_DIR", tmp_path / "vs")

    r = HybridRetriever()
    r.embeddings = FakeEmbeddings()
    docs = [
        make_doc("alpha.md", 0, "alpha content about apples"),
        make_doc("alpha.md", 1, "alpha content about oranges"),
        make_doc("beta.md", 0, "beta content about bananas"),
    ]
    r.vector_store = FAISS.from_documents(docs, r.embeddings)
    r.all_documents = list(docs)
    r.bm25_retriever = BM25Retriever.from_documents(docs)
    r._initialized = True
    return r


def sources(r: HybridRetriever) -> set:
    return {d.metadata["source"] for d in r.all_documents}


class TestIncrementalAdd:
    def test_adds_only_new_file(self, retriever, tmp_path, monkeypatch):
        monkeypatch.setattr(
            document_loader, "load_and_chunk_documents",
            lambda only_files=None, **kw: [
                make_doc("gamma.md", 0, "gamma content about grapes")
            ] if only_files == {"gamma.md"} else [],
        )
        version_before = retriever.index_version
        assert retriever.add_files_incremental(["gamma.md"]) is True
        assert sources(retriever) == {"alpha.md", "beta.md", "gamma.md"}
        assert retriever.index_version == version_before + 1
        # FAISS grew by exactly the new chunk
        assert retriever.vector_store.index.ntotal == 4

    def test_reupload_replaces_old_chunks(self, retriever, monkeypatch):
        monkeypatch.setattr(
            document_loader, "load_and_chunk_documents",
            lambda only_files=None, **kw: [
                make_doc("alpha.md", 0, "alpha v2 rewritten")
            ],
        )
        assert retriever.add_files_incremental(["alpha.md"]) is True
        alpha_chunks = [d for d in retriever.all_documents
                       if d.metadata["source"] == "alpha.md"]
        assert len(alpha_chunks) == 1
        assert "v2" in alpha_chunks[0].page_content
        assert retriever.vector_store.index.ntotal == 2  # 1 alpha + 1 beta

    def test_new_file_is_retrievable(self, retriever, monkeypatch):
        monkeypatch.setattr(
            document_loader, "load_and_chunk_documents",
            lambda only_files=None, **kw: [
                make_doc("gamma.md", 0, "unique zanzibar keyword text")
            ],
        )
        retriever.add_files_incremental(["gamma.md"])
        results = retriever.retrieve("unique zanzibar keyword text", top_k=3)
        assert any(x["doc"].metadata["source"] == "gamma.md" for x in results)

    def test_placeholder_index_forces_full_rebuild(self, retriever):
        retriever.all_documents.append(
            make_doc("placeholder.md", 0, "placeholder"))
        assert retriever.add_files_incremental(["gamma.md"]) is False

    def test_no_vector_store_forces_full_rebuild(self):
        r = HybridRetriever()
        assert r.add_files_incremental(["x.md"]) is False


class TestIncrementalRemove:
    def test_removes_only_that_files_chunks(self, retriever):
        assert retriever.remove_file_incremental("alpha.md") is True
        assert sources(retriever) == {"beta.md"}
        assert retriever.vector_store.index.ntotal == 1

    def test_removed_content_not_retrievable(self, retriever):
        retriever.remove_file_incremental("alpha.md")
        results = retriever.retrieve("alpha content about apples", top_k=3)
        assert all(x["doc"].metadata["source"] != "alpha.md" for x in results)

    def test_removing_last_file_falls_back(self, retriever):
        retriever.remove_file_incremental("alpha.md")
        assert retriever.remove_file_incremental("beta.md") is False
        # State untouched by the refused operation
        assert sources(retriever) == {"beta.md"}

    def test_persists_to_disk(self, retriever, tmp_path):
        retriever.remove_file_incremental("alpha.md")
        assert (tmp_path / "vs" / "index.faiss").exists()
        assert (tmp_path / "vs" / "bm25.pkl").exists()

    def test_retrieval_cache_invalidated(self, retriever):
        retriever.retrieve_detailed("bananas", top_k=2)
        assert len(retriever._retrieval_cache) == 1
        retriever.remove_file_incremental("alpha.md")
        assert len(retriever._retrieval_cache) == 0
