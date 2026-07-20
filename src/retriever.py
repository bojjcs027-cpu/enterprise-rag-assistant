import hashlib
import pickle
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from langchain_core.documents import Document
from langchain_community.vectorstores import FAISS
from langchain_community.retrievers import BM25Retriever
from src import config, document_loader, redis_backend, reranker

# Use the up-to-date langchain_huggingface package; fall back to community if not installed
try:
    from langchain_huggingface import HuggingFaceEmbeddings
except ImportError:
    from langchain_community.embeddings import HuggingFaceEmbeddings  # type: ignore

# Cache capacities (small, bounded — entries are a few KB each)
EMBED_CACHE_SIZE = 256
RETRIEVAL_CACHE_SIZE = 64


class HybridRetriever:
    def __init__(self):
        self.embeddings = None
        self.vector_store = None
        self.bm25_retriever = None
        self.all_documents = []
        self._initialized = False
        # Optimization state: query-embedding LRU and retrieval-result LRU.
        # index_version is bumped on every reindex so cached retrievals from a
        # previous index generation can never be served.
        self._embed_cache: "OrderedDict[str, list]" = OrderedDict()
        self._retrieval_cache: "OrderedDict[tuple, dict]" = OrderedDict()
        self.index_version = 0
        # Serialises first-time initialization: without it two concurrent
        # first requests would both load the embedding model and indexes.
        self._init_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Cached query embedding (avoids re-embedding the same query across
    # cache check, vector search, and the debug endpoint)
    # ------------------------------------------------------------------

    def embed_query_cached(self, text: str) -> list:
        if text in self._embed_cache:
            self._embed_cache.move_to_end(text)
            return self._embed_cache[text]
        vec = self.embeddings.embed_query(text)
        self._embed_cache[text] = vec
        if len(self._embed_cache) > EMBED_CACHE_SIZE:
            self._embed_cache.popitem(last=False)
        return vec

    def initialize(self, force_reindex: bool = False):
        """Initializes the embeddings, FAISS vector store, and BM25 index.
        Thread-safe; subsequent calls are no-ops unless force_reindex."""
        if self._initialized and not force_reindex:
            return
        with self._init_lock:
            if self._initialized and not force_reindex:  # lost the race — done
                return
            self._initialize_locked(force_reindex)

    def _initialize_locked(self, force_reindex: bool):
        print("Initializing Embeddings model (sentence-transformers)...")
        # Load local HuggingFace embeddings
        self.embeddings = HuggingFaceEmbeddings(
            model_name=config.EMBEDDING_MODEL_NAME,
            model_kwargs={'device': 'cpu'}
        )

        vector_db_path = Path(config.VECTOR_DB_DIR)
        bm25_path = vector_db_path / "bm25.pkl"

        if vector_db_path.exists() and (vector_db_path / "index.faiss").exists() and bm25_path.exists() and not force_reindex:
            print(f"Loading existing indexes from {vector_db_path}...")
            try:
                self.vector_store = FAISS.load_local(
                    str(vector_db_path), 
                    self.embeddings, 
                    allow_dangerous_deserialization=True
                )
                with open(bm25_path, "rb") as f:
                    saved_data = pickle.load(f)
                    self.bm25_retriever = saved_data["retriever"]
                    self.all_documents = saved_data.get("documents", [])
            except Exception as e:
                print(f"Error loading existing indexes: {e}. Reindexing...")
                self.reindex()
        else:
            print("No existing indexes found or force_reindex=True. Reindexing...")
            self.reindex()

        self._initialized = True

    def reindex(self, progress_callback=None):
        """Loads documents from data/, builds FAISS and BM25 indexes, and saves them to disk.

        progress_callback, when provided, is invoked with a stage name at each
        pipeline boundary: "chunking", "embedding", "indexing". Purely
        additive instrumentation — behaviour is unchanged when omitted.
        """
        def notify(stage: str):
            if progress_callback:
                try:
                    progress_callback(stage)
                except Exception:
                    pass  # progress reporting must never break indexing

        notify("chunking")
        docs = document_loader.load_and_chunk_documents()
        if not docs:
            print("Warning: No documents found to index in data/.")
            # Create a mock document to avoid crash
            docs = [Document(
                page_content="OmniCorp policy handbook placeholder.",
                metadata={"source": "placeholder.md", "section": "General", "chunk_id": "placeholder_0"}
            )]
        
        self.all_documents = docs

        # Build Vector Store
        notify("embedding")
        print(f"Building FAISS vector store for {len(docs)} chunks...")
        self.vector_store = FAISS.from_documents(docs, self.embeddings)

        # Save Vector Store
        notify("indexing")
        vector_db_path = Path(config.VECTOR_DB_DIR)
        vector_db_path.mkdir(parents=True, exist_ok=True)
        self.vector_store.save_local(str(vector_db_path))

        # Build BM25
        print(f"Building BM25 sparse retriever for {len(docs)} chunks...")
        self.bm25_retriever = BM25Retriever.from_documents(docs)
        self.bm25_retriever.k = config.TOP_K_RETRIEVAL

        # Save BM25 and Document mappings
        bm25_path = vector_db_path / "bm25.pkl"
        with open(bm25_path, "wb") as f:
            pickle.dump({
                "retriever": self.bm25_retriever,
                "documents": self.all_documents
            }, f)

        # Invalidate cached retrievals — they belong to the previous index.
        self.index_version += 1
        self._retrieval_cache.clear()

        print("Indexing completed and files saved to disk.")

    def rrf_fusion(
        self, 
        vector_results: List[Document], 
        bm25_results: List[Document], 
        k: int = 60,
        top_n: int = config.TOP_K_RETRIEVAL
    ) -> List[Dict[str, Any]]:
        """
        Merges results from Vector and BM25 retrievers using Reciprocal Rank Fusion (RRF).
        Returns a list of dictionaries with Document objects and fusion metadata.
        """
        rrf_scores = {}
        
        # Helper to retrieve chunk_id or generate one if missing
        def get_chunk_id(doc: Document) -> str:
            return doc.metadata.get("chunk_id", doc.page_content)

        # 1. Score Vector results
        for rank, doc in enumerate(vector_results, start=1):
            chunk_id = get_chunk_id(doc)
            if chunk_id not in rrf_scores:
                rrf_scores[chunk_id] = {
                    "doc": doc,
                    "vector_rank": rank,
                    "bm25_rank": None,
                    "score": 0.0
                }
            rrf_scores[chunk_id]["score"] += 1.0 / (k + rank)

        # 2. Score BM25 results
        for rank, doc in enumerate(bm25_results, start=1):
            chunk_id = get_chunk_id(doc)
            if chunk_id not in rrf_scores:
                rrf_scores[chunk_id] = {
                    "doc": doc,
                    "vector_rank": None,
                    "bm25_rank": rank,
                    "score": 0.0
                }
            else:
                rrf_scores[chunk_id]["bm25_rank"] = rank
            rrf_scores[chunk_id]["score"] += 1.0 / (k + rank)

        # 3. Sort by combined RRF score descending
        sorted_docs = sorted(rrf_scores.values(), key=lambda x: x["score"], reverse=True)
        return sorted_docs[:top_n]

    def retrieve(self, query: str, top_k: int = config.TOP_K_RETRIEVAL) -> List[Dict[str, Any]]:
        """
        Runs hybrid retrieval (Vector + BM25) and fuses results using RRF.
        Returns a list of dicts: {"doc": Document, "vector_rank": int/None, "bm25_rank": int/None, "score": float}
        """
        return self.retrieve_detailed(query, top_k=top_k)["fused"]

    # ------------------------------------------------------------------
    # Detailed retrieval: real per-stage scores and timings
    # ------------------------------------------------------------------

    def _bm25_with_scores(self, query: str, top_k: int) -> List[Tuple[Document, float]]:
        """BM25 top-k with raw Okapi BM25 scores. Replicates BM25Retriever's
        own ranking (same vectorizer, same preprocess_func) but keeps the
        scores, which the LangChain wrapper discards."""
        bm25 = self.bm25_retriever
        if not bm25:
            return []
        scores = bm25.vectorizer.get_scores(bm25.preprocess_func(query))
        order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
        return [(bm25.docs[i], float(scores[i])) for i in order]

    def retrieve_detailed(
        self,
        query: str,
        top_k: int = config.TOP_K_RETRIEVAL,
        query_embedding: Optional[list] = None,
    ) -> Dict[str, Any]:
        """
        Full hybrid retrieval with real scores and per-stage timings.

        Returns {
          "fused":  RRF-merged items, each carrying bm25_score / vector_similarity,
          "bm25":   [{doc, bm25_score}],
          "vector": [{doc, vector_distance, vector_similarity}],
          "timings_ms": {bm25, vector, fusion, total},
          "from_cache": bool,
        }

        An exact-match LRU keyed on (query, top_k, index_version) skips
        recomputation for repeated queries; reindexing invalidates it.
        """
        self.initialize()

        cache_key = (query, top_k, self.index_version)
        cached = self._retrieval_cache.get(cache_key)
        if cached is not None:
            self._retrieval_cache.move_to_end(cache_key)
            return {**cached, "from_cache": True}

        # L2: shared Redis cache (best-effort; entries are TTL-bounded and
        # keyed on the index generation so reindexes change the key).
        redis_key = None
        r = redis_backend.get_redis()
        if r is not None:
            digest = hashlib.sha256(
                f"{query}|{top_k}|{self.index_version}".encode("utf-8")
            ).hexdigest()
            redis_key = f"rag:retrieval:{digest}"
            try:
                blob = r.get(redis_key)
                if blob is not None:
                    result = pickle.loads(blob)
                    self._retrieval_cache[cache_key] = result  # promote to L1
                    return {**result, "from_cache": True}
            except Exception:
                redis_key = None  # skip the write path this request too

        t0 = time.perf_counter()

        # --- Sparse (BM25) with real scores ---
        bm25_pairs = self._bm25_with_scores(query, top_k)
        t1 = time.perf_counter()

        # --- Dense (FAISS) with real distances; reuse the query embedding ---
        vector_pairs: List[Tuple[Document, float]] = []
        if self.vector_store:
            if query_embedding is None:
                query_embedding = self.embed_query_cached(query)
            vector_pairs = self.vector_store.similarity_search_with_score_by_vector(
                query_embedding, k=top_k
            )
        t2 = time.perf_counter()

        # --- RRF fusion, then attach the per-retriever scores ---
        bm25_docs   = [d for d, _ in bm25_pairs]
        vector_docs = [d for d, _ in vector_pairs]
        fused = self.rrf_fusion(vector_docs, bm25_docs, top_n=top_k)

        def cid(doc: Document) -> str:
            return doc.metadata.get("chunk_id", doc.page_content)

        bm25_score_map = {cid(d): s for d, s in bm25_pairs}
        # FAISS returns L2 distance (lower = closer); expose both the raw
        # distance and a bounded similarity 1/(1+distance).
        vec_dist_map = {cid(d): float(s) for d, s in vector_pairs}
        for item in fused:
            key = cid(item["doc"])
            item["bm25_score"] = bm25_score_map.get(key)
            dist = vec_dist_map.get(key)
            item["vector_distance"]   = dist
            item["vector_similarity"] = (1.0 / (1.0 + dist)) if dist is not None else None
        t3 = time.perf_counter()

        result = {
            "fused": fused,
            "bm25": [{"doc": d, "bm25_score": s} for d, s in bm25_pairs],
            "vector": [
                {"doc": d, "vector_distance": float(s),
                 "vector_similarity": 1.0 / (1.0 + float(s))}
                for d, s in vector_pairs
            ],
            "timings_ms": {
                "bm25":   round((t1 - t0) * 1000, 2),
                "vector": round((t2 - t1) * 1000, 2),
                "fusion": round((t3 - t2) * 1000, 2),
                "total":  round((t3 - t0) * 1000, 2),
            },
            "from_cache": False,
        }

        self._retrieval_cache[cache_key] = result
        if len(self._retrieval_cache) > RETRIEVAL_CACHE_SIZE:
            self._retrieval_cache.popitem(last=False)

        if redis_key is not None:
            try:
                r.setex(redis_key, config.REDIS_RETRIEVAL_TTL_SECONDS,
                        pickle.dumps(result))
            except Exception:
                pass  # shared cache is best-effort

        return result

# Module-level singletons
retriever_instance = HybridRetriever()
# Expose reranker so app.py can do: from src import retriever; retriever.reranker_instance
reranker_instance  = reranker.reranker_instance

if __name__ == "__main__":
    # Test execution
    retriever_instance.initialize(force_reindex=True)
    results = retriever_instance.retrieve("What are the AWS IAM password and MFA policies?")
    print(f"\nRetrieved {len(results)} docs:")
    for r in results:
        doc = r["doc"]
        print(f"- Source: {doc.metadata['source']} | Section: {doc.metadata['section']}")
        print(f"  Vector Rank: {r['vector_rank']} | BM25 Rank: {r['bm25_rank']} | RRF Score: {r['score']:.4f}")
        print(f"  Snippet: {doc.page_content[:120]}...\n")
