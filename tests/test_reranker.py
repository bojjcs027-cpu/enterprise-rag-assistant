import pytest
from langchain_core.documents import Document
from src.reranker import DocumentReranker

def test_reranker_fallback_on_no_model():
    """Verify that when no cross-encoder model is present, the retriever rankings pass through."""
    reranker = DocumentReranker()
    reranker.model = None  # Force no model loaded
    reranker._initialized = True  # Prevent re-initialization inside rerank()
    
    doc1 = Document(page_content="Compliance rules", metadata={"chunk_id": "d1"})
    doc2 = Document(page_content="Encryption guide", metadata={"chunk_id": "d2"})

    hybrid_results = [
        {"doc": doc1, "vector_rank": 1, "bm25_rank": None, "score": 0.05},
        {"doc": doc2, "vector_rank": None, "bm25_rank": 1, "score": 0.04}
    ]

    reranked = reranker.rerank("What is the compliance rule?", hybrid_results)
    
    assert len(reranked) == 2
    # Should maintain original order
    assert reranked[0]["doc"].metadata["chunk_id"] == "d1"
    assert reranked[0]["rerank_score"] == 0.05
    assert reranked[1]["doc"].metadata["chunk_id"] == "d2"
    assert reranked[1]["rerank_score"] == 0.04

def test_reranker_handles_empty_candidates():
    """Checks that reranker returns an empty list for empty candidates."""
    reranker = DocumentReranker()
    assert reranker.rerank("some query", []) == []
