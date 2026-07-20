import os
from typing import List, Dict, Any
from sentence_transformers import CrossEncoder
from src import config

class DocumentReranker:
    def __init__(self):
        self.model = None
        self._initialized = False

    def initialize(self):
        """Initializes the cross-encoder model."""
        if self._initialized:
            return
        
        print(f"Initializing CrossEncoder model ({config.RERANK_MODEL_NAME})...")
        try:
            self.model = CrossEncoder(config.RERANK_MODEL_NAME, device="cpu")
            self._initialized = True
        except Exception as e:
            print(f"Error loading CrossEncoder: {e}. Falling back to pass-through (no reranking).")
            self.model = None
            # Do not set _initialized = True to retry later or allow fallbacks

    def rerank(self, query: str, hybrid_results: List[Dict[str, Any]], top_k: int = config.TOP_K_RERANK) -> List[Dict[str, Any]]:
        """
        Reranks hybrid retrieval results using the cross-encoder.
        Each dictionary in hybrid_results is expected to have:
            {"doc": Document, "vector_rank": int/None, "bm25_rank": int/None, "score": float}
        Modifies each dictionary to add "rerank_score" and returns the top_k sorted results.
        """
        if not hybrid_results:
            return []

        self.initialize()

        # If the model failed to load, pass through the hybrid results directly (limited to top_k)
        if not self.model:
            print("Cross-encoder model not loaded. Skipping rerank step (pass-through mode).")
            for item in hybrid_results:
                item["rerank_score"] = float(item["score"])
            return hybrid_results[:top_k]

        # Prepare inputs for the cross-encoder: list of [query, document_text]
        pairs = [[query, item["doc"].page_content] for item in hybrid_results]

        # Compute cross-encoder scores
        try:
            scores = self.model.predict(pairs)
            
            # Map scores back to items
            for idx, score in enumerate(scores):
                # Convert numpy float to native float for JSON serialization
                hybrid_results[idx]["rerank_score"] = float(score)

            # Sort items by rerank_score in descending order
            reranked_results = sorted(hybrid_results, key=lambda x: x["rerank_score"], reverse=True)
            return reranked_results[:top_k]
            
        except Exception as e:
            print(f"Error during reranking inference: {e}. Returning original ranking.")
            # Fallback to original order, set a dummy score
            for idx, item in enumerate(hybrid_results):
                item["rerank_score"] = float(item["score"])
            return hybrid_results[:top_k]

# Global instance for easy importing across components
reranker_instance = DocumentReranker()
