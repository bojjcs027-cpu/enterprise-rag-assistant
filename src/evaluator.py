import os
import json
import time
from typing import List, Dict, Any
import numpy as np
from src import config, chain, retriever

def compute_cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """Computes the cosine similarity between two vectors."""
    v1 = np.array(vec1)
    v2 = np.array(vec2)
    dot_product = np.dot(v1, v2)
    norm_v1 = np.linalg.norm(v1)
    norm_v2 = np.linalg.norm(v2)
    if norm_v1 == 0 or norm_v2 == 0:
        return 0.0
    return float(dot_product / (norm_v1 * norm_v2))

class RAGEvaluator:
    def __init__(self):
        self.chain = chain.rag_chain_instance
        self.history_file = config.DATA_DIR / "eval_history.json"

    def run_evaluation(self) -> Dict[str, Any]:
        """
        Runs evaluation on the dataset at data/eval_dataset.json.
        Computes retrieval, citation, and semantic metrics.
        """
        # Ensure retriever is initialized to load embeddings
        self.chain.retriever.initialize()
        embeddings = self.chain.retriever.embeddings

        dataset_path = config.DATA_DIR / "eval_dataset.json"
        if not dataset_path.exists():
            raise FileNotFoundError(f"Evaluation dataset not found at {dataset_path}")

        with open(dataset_path, "r", encoding="utf-8") as f:
            test_cases = json.load(f)

        results = []
        overall_mrr = []
        overall_retrieval_recall = []
        overall_citation_precision = []
        overall_citation_recall = []
        overall_semantic_similarity = []
        overall_faithfulness = []
        overall_answer_relevance = []
        overall_latency = []

        print(f"Running evaluation on {len(test_cases)} test cases...")

        for idx, case in enumerate(test_cases):
            query = case["query"]
            ground_truth = case["ground_truth"]
            expected_citations = case["expected_citations"]

            start_time = time.time()
            rag_output = self.chain.answer_question(query)
            latency = time.time() - start_time
            overall_latency.append(latency)

            # 1. Retrieval Metrics
            retrieved_sources = [
                f"{doc['source']}#{doc['section']}" for doc in rag_output["reranked_documents"]
            ]
            
            # Recall@K: What proportion of expected citations are in retrieved sources
            found_citations = [c for c in expected_citations if c in retrieved_sources]
            recall = len(found_citations) / len(expected_citations) if expected_citations else 1.0
            overall_retrieval_recall.append(recall)

            # MRR: Reciprocal rank of the first relevant expected citation
            mrr = 0.0
            for rank, src in enumerate(retrieved_sources, start=1):
                if src in expected_citations:
                    mrr = 1.0 / rank
                    break
            overall_mrr.append(mrr)

            # 2. Citation Metrics
            generated_citations = rag_output["citations"]
            
            # Citation Precision: Are generated citations actually in the retrieved documents?
            # (Prevents hallucinating sources not given to LLM)
            valid_citations = [c for c in generated_citations if c in retrieved_sources]
            citation_precision = (
                len(valid_citations) / len(generated_citations) if generated_citations else 1.0
            )
            overall_citation_precision.append(citation_precision)

            # Citation Recall: Did LLM cite all expected documents that were successfully retrieved?
            retrieved_expected = [c for c in expected_citations if c in retrieved_sources]
            if retrieved_expected:
                citation_recall = len([c for c in retrieved_expected if c in generated_citations]) / len(retrieved_expected)
            else:
                citation_recall = 1.0
            overall_citation_recall.append(citation_recall)

            # 3. Semantic Similarity (using local sentence embeddings)
            try:
                gen_emb = embeddings.embed_query(rag_output["answer"])
                gt_emb = embeddings.embed_query(ground_truth)
                q_emb = embeddings.embed_query(query)
                
                # Context embedding for faithfulness (approximate)
                combined_context = " ".join([doc["content"] for doc in rag_output["reranked_documents"]])
                ctx_emb = embeddings.embed_query(combined_context[:2000]) if combined_context else None
                
                sem_sim = compute_cosine_similarity(gen_emb, gt_emb)
                ans_rel = compute_cosine_similarity(gen_emb, q_emb)
                faith = compute_cosine_similarity(gen_emb, ctx_emb) if ctx_emb else 0.0
                
            except Exception as e:
                print(f"Error computing embedding similarity: {e}")
                sem_sim = 0.0
                ans_rel = 0.0
                faith = 0.0
                
            overall_semantic_similarity.append(sem_sim)
            overall_answer_relevance.append(ans_rel)
            overall_faithfulness.append(faith)

            results.append({
                "query": query,
                "answer": rag_output["answer"],
                "ground_truth": ground_truth,
                "latency_seconds": latency,
                "retrieved_sources": retrieved_sources,
                "generated_citations": generated_citations,
                "retrieval_recall": recall,
                "mrr": mrr,
                "citation_precision": citation_precision,
                "citation_recall": citation_recall,
                "semantic_similarity": sem_sim,
                "answer_relevance": ans_rel,
                "faithfulness": faith,
                "hallucination_score": max(0, 1.0 - faith) # Inverse of faithfulness
            })

            print(f"[{idx+1}/{len(test_cases)}] Query: '{query[:40]}...' | Latency: {latency:.2f}s | Sim: {sem_sim:.2f}")

        # Compute summary metrics
        summary = {
            "timestamp": time.time(),
            "llm_provider": config.LLM_PROVIDER,
            "mean_latency": float(np.mean(overall_latency)),
            "mean_retrieval_recall": float(np.mean(overall_retrieval_recall)),
            "mean_mrr": float(np.mean(overall_mrr)),
            "mean_citation_precision": float(np.mean(overall_citation_precision)),
            "mean_citation_recall": float(np.mean(overall_citation_recall)),
            "mean_semantic_similarity": float(np.mean(overall_semantic_similarity)),
            "mean_answer_relevance": float(np.mean(overall_answer_relevance)),
            "mean_faithfulness": float(np.mean(overall_faithfulness)),
            "mean_hallucination": float(np.mean([max(0, 1.0 - f) for f in overall_faithfulness])),
            "test_cases": results
        }

        # Save history
        self._save_to_history(summary)
        return summary

    def _save_to_history(self, summary: Dict[str, Any]):
        """Appends the evaluation summary to history logs."""
        history = []
        if self.history_file.exists():
            try:
                with open(self.history_file, "r", encoding="utf-8") as f:
                    history = json.load(f)
            except Exception:
                history = []

        history.append(summary)
        
        # Limit history to last 50 runs to save space
        if len(history) > 50:
            history = history[-50:]

        with open(self.history_file, "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2)

    def get_history(self) -> List[Dict[str, Any]]:
        """Returns the full evaluation history."""
        if not self.history_file.exists():
            return []
        try:
            with open(self.history_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

# Global instance
evaluator_instance = RAGEvaluator()

if __name__ == "__main__":
    # Test evaluation run
    summary = evaluator_instance.run_evaluation()
    print("\nEvaluation Summary:")
    print(f"Mean Latency: {summary['mean_latency']:.2f}s")
    print(f"Mean Retrieval Recall: {summary['mean_retrieval_recall']:.2f}")
    print(f"Mean MRR: {summary['mean_mrr']:.2f}")
    print(f"Mean Citation Precision: {summary['mean_citation_precision']:.2f}")
    print(f"Mean Citation Recall: {summary['mean_citation_recall']:.2f}")
    print(f"Mean Semantic Similarity: {summary['mean_semantic_similarity']:.2f}")
