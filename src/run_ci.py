import sys
import time
from src import retriever, evaluator

# Defined Thresholds for CI Gate
RECALL_THRESHOLD = 0.80
CITATION_PRECISION_THRESHOLD = 0.80
SEMANTIC_SIMILARITY_THRESHOLD = 0.70

def main():
    print("=========================================")
    print("   Starting CI-Gated Evaluation Gate    ")
    print("=========================================\n")

    start_time = time.time()

    # 1. Force rebuild vector and keyword indexes from files
    print("Reindexing all source files...")
    try:
        retriever.retriever_instance.initialize(force_reindex=True)
    except Exception as e:
        print(f"FAILED: Document Indexing failed: {e}")
        sys.exit(1)

    # 2. Run evaluation
    print("\nRunning test suite queries...")
    try:
        summary = evaluator.evaluator_instance.run_evaluation()
    except Exception as e:
        print(f"FAILED: Evaluation run failed: {e}")
        sys.exit(1)

    # 3. Assess results against thresholds
    passed = True
    print("\n=========================================")
    print("           CI Gate Thresholds            ")
    print("=========================================")

    # Retrieval Recall check
    recall = summary["mean_retrieval_recall"]
    if recall >= RECALL_THRESHOLD:
        print(f" [PASS] Mean Retrieval Recall: {recall:.2f} (Threshold: >= {RECALL_THRESHOLD:.2f})")
    else:
        print(f" [FAIL] Mean Retrieval Recall: {recall:.2f} (Threshold: >= {RECALL_THRESHOLD:.2f})")
        passed = False

    # Citation Precision check
    citation_precision = summary["mean_citation_precision"]
    if citation_precision >= CITATION_PRECISION_THRESHOLD:
        print(f" [PASS] Mean Citation Precision: {citation_precision:.2f} (Threshold: >= {CITATION_PRECISION_THRESHOLD:.2f})")
    else:
        print(f" [FAIL] Mean Citation Precision: {citation_precision:.2f} (Threshold: >= {CITATION_PRECISION_THRESHOLD:.2f})")
        passed = False

    # Semantic Similarity check
    similarity = summary["mean_semantic_similarity"]
    if similarity >= SEMANTIC_SIMILARITY_THRESHOLD:
        print(f" [PASS] Mean Semantic Similarity: {similarity:.2f} (Threshold: >= {SEMANTIC_SIMILARITY_THRESHOLD:.2f})")
    else:
        print(f" [FAIL] Mean Semantic Similarity: {similarity:.2f} (Threshold: >= {SEMANTIC_SIMILARITY_THRESHOLD:.2f})")
        passed = False

    total_time = time.time() - start_time
    print(f"\nEvaluation took {total_time:.2f} seconds.")
    print("=========================================")

    if passed:
        print("\nSUCCESS: All RAG metrics passed CI gate threshold requirements.")
        sys.exit(0)
    else:
        print("\nFAILURE: RAG metrics did not satisfy performance requirements.")
        sys.exit(1)

if __name__ == "__main__":
    main()
