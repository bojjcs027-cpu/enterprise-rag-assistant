import pytest
from langchain_core.documents import Document
from src.retriever import HybridRetriever

def test_rrf_fusion_logic():
    """Tests that RRF fuses vector and BM25 lists correctly with standard weights."""
    retriever = HybridRetriever()

    # Create dummy documents
    doc1 = Document(page_content="Content 1", metadata={"chunk_id": "doc1", "source": "s1"})
    doc2 = Document(page_content="Content 2", metadata={"chunk_id": "doc2", "source": "s2"})
    doc3 = Document(page_content="Content 3", metadata={"chunk_id": "doc3", "source": "s3"})

    # Case 1: doc1 is first in vector, second in BM25
    # doc2 is second in vector, first in BM25
    # doc3 is third in vector, not in BM25
    vector_results = [doc1, doc2, doc3]
    bm25_results = [doc2, doc1]

    # Calculate expected scores using standard formula: 1 / (60 + rank)
    # k = 60
    # doc1: vector rank 1 (1/61), bm25 rank 2 (1/62) -> 1/61 + 1/62 = 0.01639 + 0.01613 = 0.03252
    # doc2: vector rank 2 (1/62), bm25 rank 1 (1/61) -> 1/62 + 1/61 = 0.03252
    # doc3: vector rank 3 (1/63), bm25 rank None -> 1/63 = 0.01587

    fused = retriever.rrf_fusion(vector_results, bm25_results, k=60)

    assert len(fused) == 3
    # Both doc1 and doc2 should be ranked top, but check sorting
    assert fused[0]["doc"].metadata["chunk_id"] in ["doc1", "doc2"]
    assert fused[1]["doc"].metadata["chunk_id"] in ["doc1", "doc2"]
    assert fused[2]["doc"].metadata["chunk_id"] == "doc3"
    
    # Verify score values
    assert abs(fused[2]["score"] - (1.0 / 63.0)) < 1e-6
    assert abs(fused[0]["score"] - (1.0 / 61.0 + 1.0 / 62.0)) < 1e-6

def test_rrf_handles_empty_lists():
    """Verify RRF executes without errors on empty retrievals."""
    retriever = HybridRetriever()
    fused = retriever.rrf_fusion([], [])
    assert len(fused) == 0
