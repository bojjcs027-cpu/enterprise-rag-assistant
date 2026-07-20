# torch must be imported before anything else: on some Windows machines its
# c10.dll fails to initialize (WinError 1114) when other packages' DLLs load
# first. Same workaround as tests/conftest.py.
try:
    import torch  # noqa: F401
except OSError:  # pragma: no cover — environment-specific DLL flakiness
    pass

import argparse
import sys
import uvicorn
from src import config, retriever, evaluator

def run_server():
    """Starts the FastAPI server.

    Model/index loading happens once, inside the app's lifespan hook
    (src/app.py). Do NOT preload here: with reload workers the models
    would be loaded twice (parent + worker), doubling memory usage and
    startup time.
    """
    print(f"Starting server at http://{config.HOST}:{config.PORT}...")
    print("(Models load on startup — the first status may take a minute.)")
    uvicorn.run("src.app:app", host=config.HOST, port=config.PORT, reload=False)

def run_eval():
    """Starts evaluation over the test dataset."""
    print("Starting evaluation...")
    summary = evaluator.evaluator_instance.run_evaluation()
    print("\n=========================================")
    print("           Evaluation Results            ")
    print("=========================================")
    print(f"Model Provider: {summary['llm_provider']}")
    print(f"Mean Latency: {summary['mean_latency']:.2f}s")
    print(f"Mean Retrieval Recall: {summary['mean_retrieval_recall']:.2f}")
    print(f"Mean MRR: {summary['mean_mrr']:.2f}")
    print(f"Mean Citation Precision: {summary['mean_citation_precision']:.2f}")
    print(f"Mean Citation Recall: {summary['mean_citation_recall']:.2f}")
    print(f"Mean Semantic Similarity: {summary['mean_semantic_similarity']:.2f}")
    print("=========================================")

def run_reindex():
    """Triggers standard reindexing of documents in data/."""
    print("Rebuilding indexes...")
    retriever.retriever_instance.initialize(force_reindex=True)
    print("Reindexing complete.")

def main():
    parser = argparse.ArgumentParser(description="OmniCorp RAG Assistant CLI Control")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--server", action="store_true", help="Start the FastAPI dashboard server")
    group.add_argument("--eval", action="store_true", help="Run the RAG evaluation suite")
    group.add_argument("--reindex", action="store_true", help="Re-chunk and re-index data/ documents")
    
    args = parser.parse_args()
    
    if args.server:
        run_server()
    elif args.eval:
        run_eval()
    elif args.reindex:
        run_reindex()

if __name__ == "__main__":
    main()
