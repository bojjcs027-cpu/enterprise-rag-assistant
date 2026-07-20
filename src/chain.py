"""
RAG Chain — Orchestrates retrieval, reranking, and LLM-based answer generation.

LLM Priority Order:
  1. Gemini (if LLM_PROVIDER=gemini and GEMINI_API_KEY is set)
  2. OpenAI  (if LLM_PROVIDER=openai and OPENAI_API_KEY is set)
  3. Local HuggingFace flan-t5 (if LLM_PROVIDER=local) — no API key required
  4. Extractive fallback (sentence extraction + auto-citation) — last resort only
"""

import re
import os
import math
import time
import uuid
import pickle
import numpy as np
from pathlib import Path
from typing import List, Dict, Any, Optional

from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.language_models.llms import LLM
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI

from src import config, redis_backend, retriever, reranker

import logging
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Local seq2seq LLM wrapper
# ---------------------------------------------------------------------------

class LocalSeq2SeqLLM(LLM):
    """
    Minimal LangChain LLM wrapper around a HuggingFace AutoModelForSeq2SeqLM.

    Newer transformers releases (5.x) dropped the "text2text-generation"
    pipeline task and the Text2TextGenerationPipeline class entirely, so we
    call model.generate() directly instead of going through pipeline()/
    HuggingFacePipeline — this keeps the local model working regardless of
    which pipeline tasks a given transformers version still registers.
    """

    model: Any = None
    tokenizer: Any = None
    max_new_tokens: int = 512

    @property
    def _llm_type(self) -> str:
        return "local_seq2seq"

    def _call(self, prompt: str, stop=None, run_manager=None, **kwargs) -> str:
        inputs = self.tokenizer(prompt, return_tensors="pt", truncation=True, max_length=1024)
        output_ids = self.model.generate(**inputs, max_new_tokens=self.max_new_tokens)
        return self.tokenizer.decode(output_ids[0], skip_special_tokens=True)

# ---------------------------------------------------------------------------
# Semantic Cache class
# ---------------------------------------------------------------------------

class SemanticCache:
    # Bounded: oldest entries are dropped past this size, keeping memory and
    # the O(n) similarity scan per query flat.
    MAX_ENTRIES = 256

    def __init__(self, threshold: float = 0.92):
        self.threshold = threshold
        self.cache_file = Path("data") / "semantic_cache.pkl"
        self.cache = []  # List of dicts: {"embedding": np.ndarray, "payload": dict}
        # Retriever index generation this cache is valid for. None = not yet
        # synced; set on first sync_index_version call.
        self.index_version = None
        self.load()

    REDIS_KEY = "rag:semcache"

    def load(self):
        """Loads persisted entries — from Redis when configured, else the
        local pickle file. The in-memory list is always the working set;
        persistence only matters across restarts."""
        r = redis_backend.get_redis()
        if r is not None:
            try:
                blobs = r.lrange(self.REDIS_KEY, 0, -1)
                self.cache = [pickle.loads(b) for b in blobs]
                print(f"[SemanticCache] Loaded {len(self.cache)} entries from Redis.")
                return
            except Exception as e:
                print(f"[SemanticCache] Redis load failed ({e}) — trying file.")
        if self.cache_file.exists():
            try:
                with open(self.cache_file, "rb") as f:
                    self.cache = pickle.load(f)
                print(f"[SemanticCache] Loaded {len(self.cache)} entries.")
            except Exception as e:
                print(f"[SemanticCache] Error loading cache: {e}")
                self.cache = []

    def save(self):
        r = redis_backend.get_redis()
        if r is not None:
            try:
                pipe = r.pipeline()
                pipe.delete(self.REDIS_KEY)
                if self.cache:
                    pipe.rpush(self.REDIS_KEY, *(pickle.dumps(e) for e in self.cache))
                pipe.execute()
                return
            except Exception as e:
                print(f"[SemanticCache] Redis save failed ({e}) — using file.")
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.cache_file, "wb") as f:
                pickle.dump(self.cache, f)
        except Exception as e:
            print(f"[SemanticCache] Error saving cache: {e}")

    def compute_similarity(self, vec1: np.ndarray, vec2: np.ndarray) -> float:
        dot = np.dot(vec1, vec2)
        norm = np.linalg.norm(vec1) * np.linalg.norm(vec2)
        return float(dot / norm) if norm > 0 else 0.0

    def check(self, query_embedding: List[float]) -> Optional[Dict[str, Any]]:
        if not self.cache:
            return None
        q_vec = np.array(query_embedding)
        best_score = 0.0
        best_payload = None
        for entry in self.cache:
            score = self.compute_similarity(q_vec, entry["embedding"])
            if score > best_score:
                best_score = score
                best_payload = entry["payload"]
        if best_score >= self.threshold:
            print(f"[SemanticCache] Hit! Similarity: {best_score:.4f}")
            return best_payload
        return None

    def add(self, query_embedding: List[float], payload: Dict[str, Any]):
        self.cache.append({
            "embedding": np.array(query_embedding),
            "payload": payload
        })
        if len(self.cache) > self.MAX_ENTRIES:
            self.cache = self.cache[-self.MAX_ENTRIES:]
        self.save()

    def clear(self):
        """Empties the cache in memory and on disk."""
        self.cache = []
        self.save()

    def sync_index_version(self, version: int):
        """Invalidates the cache when the retrieval index generation changes —
        cached answers cite chunks that may no longer exist after a reindex."""
        if self.index_version is None:
            self.index_version = version
        elif version != self.index_version:
            print(f"[SemanticCache] Index changed (v{self.index_version} -> v{version}) — clearing cache.")
            self.index_version = version
            self.clear()

# ---------------------------------------------------------------------------
# RAG Chain class
# ---------------------------------------------------------------------------

class RAGChain:
    def __init__(self):
        self.retriever = retriever.retriever_instance
        self.reranker = reranker.reranker_instance
        self._local_llm = None          # lazy-loaded, cached after first use
        self._local_llm_failed = False  # cached failure flag — avoids retrying every request
        self.cache = SemanticCache()

    # ------------------------------------------------------------------
    # LLM selection
    # ------------------------------------------------------------------

    def _get_local_llm(self):
        """
        Loads google/flan-t5-base (or the model configured via LOCAL_LLM_MODEL)
        once and caches it for the lifetime of this process.

        NOTE: Newer transformers releases (5.x) removed "text2text-generation"
        from the pipeline() task registry along with Text2TextGenerationPipeline
        itself, so we load the model/tokenizer directly and call generate()
        via LocalSeq2SeqLLM instead of going through transformers' pipeline API.
        """
        if self._local_llm is not None:
            return self._local_llm

        # Don't retry if we already know it fails
        if self._local_llm_failed:
            return None

        logger.info("[Stage 8/LLM] Loading local LLM: %s", config.LOCAL_LLM_MODEL)
        try:
            from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

            tokenizer = AutoTokenizer.from_pretrained(config.LOCAL_LLM_MODEL)
            model     = AutoModelForSeq2SeqLM.from_pretrained(config.LOCAL_LLM_MODEL)

            self._local_llm = LocalSeq2SeqLLM(model=model, tokenizer=tokenizer, max_new_tokens=512)
            logger.info("[Stage 8/LLM] Local LLM '%s' loaded successfully.", config.LOCAL_LLM_MODEL)
            return self._local_llm

        except Exception as exc:
            logger.warning("[Stage 8/LLM] Could not load local LLM — %s. Will use extractive fallback.", exc)
            self._local_llm_failed = True
            return None

    def _get_llm(self):
        """Returns the configured LLM instance (never returns a mock object)."""
        provider = config.LLM_PROVIDER

        if provider == "gemini" and config.GEMINI_API_KEY:
            print("[RAGChain] Using Gemini API for generation.")
            return ChatGoogleGenerativeAI(
                model="gemini-1.5-flash",
                google_api_key=config.GEMINI_API_KEY,
                temperature=0.1,
            )

        if provider == "openai" and config.OPENAI_API_KEY:
            print("[RAGChain] Using OpenAI API for generation.")
            return ChatOpenAI(
                model="gpt-4o-mini",
                openai_api_key=config.OPENAI_API_KEY,
                temperature=0.1,
            )

        if provider == "local":
            return self._get_local_llm()

        # Gemini/OpenAI requested but key missing — fall back to local
        if provider in ("gemini", "openai"):
            print(
                f"[RAGChain] WARNING: LLM_PROVIDER={provider} but no API key found. "
                "Falling back to local model."
            )
            return self._get_local_llm()

        return None  # only if provider is an unrecognised string

    # ------------------------------------------------------------------
    # Prompt & context building
    # ------------------------------------------------------------------

    @staticmethod
    def _build_context(reranked_results: List[Dict[str, Any]]) -> str:
        """
        Builds the context string passed to the LLM.

        Each block is prefixed with its full citation reference so the model
        can reproduce it verbatim in the answer.
        """
        blocks = []
        for item in reranked_results:
            doc  = item["doc"]
            src  = doc.metadata.get("source",  "unknown.md")
            sec  = doc.metadata.get("section", "General")
            page = doc.metadata.get("page",    1)
            blocks.append(
                f"[{src}#{sec}, page {page}]\n{doc.page_content}"
            )
        return "\n\n---\n\n".join(blocks)

    @staticmethod
    def _get_prompt(has_history: bool = False) -> PromptTemplate:
        """
        Single prompt template that works with all LLM backends.
        Includes conversation history if available.
        """
        template = (
            "You are an expert AI compliance and security policy assistant for OmniCorp.\n"
            "Answer the user's question using ONLY the provided policy context.\n\n"
            "Rules:\n"
            "1. Base your answer solely on the Context below.\n"
            "2. For EVERY fact or policy you state, include an inline citation "
            "in the exact format: [filename.md#SectionName, page N]\n"
            "3. If the context does not contain the answer, respond exactly: "
            "\"I cannot find the answer in the provided documents.\"\n"
            "4. Do NOT invent or assume any information not present in the context.\n\n"
            "Context:\n"
            "{context}\n\n"
        )
        if has_history:
            template += "Chat History:\n{history}\n\n"
        
        template += "Question: {question}\n\nAnswer:"
        return PromptTemplate.from_template(template)

    # Maximum characters of chat history included in the prompt. The local
    # seq2seq model truncates input at 1024 tokens from the RIGHT, so an
    # unbounded history pushes the trailing "Question: ... Answer:" out of
    # the window and the model answers about the history instead.
    MAX_HISTORY_CHARS = 800

    @classmethod
    def _trim_history(cls, history: str) -> str:
        """Keeps only the most recent portion of the conversation history."""
        if len(history) <= cls.MAX_HISTORY_CHARS:
            return history
        trimmed = history[-cls.MAX_HISTORY_CHARS:]
        # Drop the leading partial line so we start at a message boundary
        newline_pos = trimmed.find("\n")
        if newline_pos != -1:
            trimmed = trimmed[newline_pos + 1:]
        logger.info("[Stage 7] Trimmed chat history from %d to %d chars", len(history), len(trimmed))
        return trimmed

    # ------------------------------------------------------------------
    # Citation utilities
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_citations(answer: str) -> List[str]:
        """
        Extracts unique citation keys in the format filename.md#SectionName
        from the answer text.

        Handles both:
          [filename.md#Section]
          [filename.md#Section, page N]

        The evaluator expects keys WITHOUT the ", page N" suffix, so we
        normalise them here.
        """
        # Match opening bracket then the file#section part (stop at ], newline, or comma)
        pattern = r'\[([a-zA-Z0-9_\-\.]+(?:#[^\],\n]+)?)'
        raw = re.findall(pattern, answer)

        normalised = set()
        for m in raw:
            key = m.split(", page")[0].strip()
            # Only keep entries that look like document references
            if "#" in key or key.endswith(".md") or key.endswith(".txt"):
                normalised.add(key)

        return list(normalised)

    def _ensure_citations(
        self,
        answer: str,
        reranked_results: List[Dict[str, Any]],
    ) -> str:
        """
        If the LLM omitted citations entirely, auto-append the top-ranked
        document references so the answer is never uncited.
        """
        if self._extract_citations(answer):
            return answer  # already cited — nothing to do

        appended = []
        for item in reranked_results[:2]:
            doc  = item["doc"]
            src  = doc.metadata.get("source",  "unknown.md")
            sec  = doc.metadata.get("section", "General")
            page = doc.metadata.get("page",    1)
            ref  = f"[{src}#{sec}, page {page}]"
            if ref not in appended:
                appended.append(ref)

        if appended:
            answer = answer.rstrip() + "  " + "  ".join(appended)

        return answer

    # ------------------------------------------------------------------
    # Extractive fallback (no LLM available)
    # ------------------------------------------------------------------

    @staticmethod
    def _extractive_fallback(
        query: str,
        reranked_results: List[Dict[str, Any]],
    ) -> str:
        """
        Sentence-extraction fallback used only when no LLM backend is reachable.
        Extracts the most relevant sentences from top chunks and auto-cites them.
        This is NOT the mock — it is genuinely derived from the retrieved documents.
        """
        if not reranked_results:
            return "I cannot find the answer in the provided documents."

        query_terms = set(query.lower().split())
        answer_parts = []

        for item in reranked_results[:2]:
            doc  = item["doc"]
            src  = doc.metadata.get("source",  "unknown.md")
            sec  = doc.metadata.get("section", "General")
            page = doc.metadata.get("page",    1)

            # Pick sentences that share at least one non-trivial token with the query
            sentences = [
                s.strip()
                for s in re.split(r"(?<=[.!?])\s+", doc.page_content)
                if len(s.strip()) > 30
            ]
            relevant = [
                s for s in sentences
                if any(t in s.lower() for t in query_terms if len(t) > 3)
            ] or sentences[:2]

            snippet = " ".join(relevant[:3]).strip()
            if snippet:
                answer_parts.append(f"{snippet} [{src}#{sec}, page {page}]")

        if not answer_parts:
            # Last-resort: first sentence of top chunk
            top = reranked_results[0]
            doc  = top["doc"]
            src  = doc.metadata.get("source",  "unknown.md")
            sec  = doc.metadata.get("section", "General")
            page = doc.metadata.get("page",    1)
            snippet = doc.page_content[:300].strip()
            answer_parts.append(f"{snippet} [{src}#{sec}, page {page}]")

        return "  ".join(answer_parts)

    # ------------------------------------------------------------------
    # Output formatters
    # ------------------------------------------------------------------

    @staticmethod
    def _format_hybrid_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {
                "content":           item["doc"].page_content,
                "source":            item["doc"].metadata.get("source"),
                "section":           item["doc"].metadata.get("section"),
                "chunk_id":          item["doc"].metadata.get("chunk_id"),
                "page":              item["doc"].metadata.get("page", 1),
                "vector_rank":       item["vector_rank"],
                "bm25_rank":         item["bm25_rank"],
                "score":             item["score"],
                "bm25_score":        item.get("bm25_score"),
                "vector_similarity": item.get("vector_similarity"),
                "vector_distance":   item.get("vector_distance"),
            }
            for item in results
        ]

    @staticmethod
    def _format_reranked_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {
                "content":           item["doc"].page_content,
                "source":            item["doc"].metadata.get("source"),
                "section":           item["doc"].metadata.get("section"),
                "chunk_id":          item["doc"].metadata.get("chunk_id"),
                "page":              item["doc"].metadata.get("page", 1),
                "vector_rank":       item["vector_rank"],
                "bm25_rank":         item["bm25_rank"],
                "score":             item["score"],
                "bm25_score":        item.get("bm25_score"),
                "vector_similarity": item.get("vector_similarity"),
                "vector_distance":   item.get("vector_distance"),
                "rerank_score":      item["rerank_score"],
                # Sigmoid of the cross-encoder logit — the model's own
                # relevance probability for this (query, chunk) pair.
                "confidence":        RAGChain._sigmoid(item["rerank_score"]),
                "final_rank":        rank,
            }
            for rank, item in enumerate(results, start=1)
        ]

    # ------------------------------------------------------------------
    # Instrumentation helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _sigmoid(x: float) -> float:
        """Overflow-safe logistic function."""
        if x >= 0:
            return 1.0 / (1.0 + math.exp(-x))
        e = math.exp(x)
        return e / (1.0 + e)

    def _count_tokens(self, text: str) -> tuple[int, bool]:
        """Returns (token_count, is_estimated). Uses the local model's real
        tokenizer when loaded; otherwise a chars/4 estimate."""
        if self._local_llm is not None and getattr(self._local_llm, "tokenizer", None):
            try:
                return len(self._local_llm.tokenizer.encode(text)), False
            except Exception:
                pass
        return max(1, len(text) // 4), True

    def _llm_model_name(self, provider: str) -> str:
        if provider == "gemini":
            return "gemini-1.5-flash"
        if provider == "openai":
            return "gpt-4o-mini"
        if provider == "extractive_fallback":
            return "sentence-extraction (no LLM)"
        return config.LOCAL_LLM_MODEL

    def _build_debug_info(self, request_id: str, provider: str) -> Dict[str, Any]:
        return {
            "request_id":      request_id,
            "llm_provider":    provider,
            "llm_model":       self._llm_model_name(provider),
            "embedding_model": config.EMBEDDING_MODEL_NAME,
            "rerank_model":    config.RERANK_MODEL_NAME,
            "chunk_count":     len(self.retriever.all_documents),
            "top_k":           config.TOP_K_RETRIEVAL,
            "rerank_k":        config.TOP_K_RERANK,
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def answer_question(self, query: str, history: str = "") -> Dict[str, Any]:
        """
        Full RAG pipeline (Non-streaming) with per-stage logging, real
        per-stage timings, and token accounting.
        """
        request_id = uuid.uuid4().hex[:8]
        t_start = time.perf_counter()
        timings: Dict[str, float] = {}
        logger.info("[Stage 1][%s] Request received — query: %r", request_id, query[:80])

        # Stage 2: Query embedding + semantic cache check
        if self.retriever.embeddings:
            t = time.perf_counter()
            query_embedding = self.retriever.embed_query_cached(query)
            timings["embedding"] = round((time.perf_counter() - t) * 1000, 2)

            self.cache.sync_index_version(self.retriever.index_version)
            t = time.perf_counter()
            cached_payload = self.cache.check(query_embedding)
            timings["cache_check"] = round((time.perf_counter() - t) * 1000, 2)

            if cached_payload:
                logger.info("[Stage 2][%s] Cache HIT — returning cached answer", request_id)
                payload = dict(cached_payload)  # don't mutate the stored entry
                payload["cached"] = True
                timings["total"] = round((time.perf_counter() - t_start) * 1000, 2)
                payload["metrics"] = {
                    "request_id": request_id,
                    "cache_hit": True,
                    "retrieval_cache_hit": False,
                    "timings_ms": timings,
                    "retrieved_chunks": len(payload.get("retrieved_documents", [])),
                    "final_chunks": len(payload.get("reranked_documents", [])),
                    "tokens": {"prompt": 0, "completion": 0, "total": 0, "estimated": False},
                }
                payload["debug"] = self._build_debug_info(
                    request_id, payload.get("provider", config.LLM_PROVIDER))
                return payload
            logger.info("[Stage 2][%s] Cache MISS — proceeding with full pipeline", request_id)
        else:
            query_embedding = None

        # Stages 3-5: Hybrid retrieval (BM25 + FAISS + RRF) with real scores
        t = time.perf_counter()
        detail = self.retriever.retrieve_detailed(
            query, top_k=config.TOP_K_RETRIEVAL, query_embedding=query_embedding)
        hybrid_results = detail["fused"]
        timings["bm25"]      = detail["timings_ms"]["bm25"]
        timings["vector"]    = detail["timings_ms"]["vector"]
        timings["fusion"]    = detail["timings_ms"]["fusion"]
        timings["retrieval"] = round((time.perf_counter() - t) * 1000, 2)
        logger.info("[Stage 3-5][%s] Retrieved %d hybrid documents (retrieval cache=%s)",
                    request_id, len(hybrid_results), detail["from_cache"])

        # Stage 6: Cross-encoder reranking
        t = time.perf_counter()
        reranked_results = self.reranker.rerank(query, hybrid_results, top_k=config.TOP_K_RERANK)
        timings["rerank"] = round((time.perf_counter() - t) * 1000, 2)
        logger.info("[Stage 6][%s] Reranked to top %d documents", request_id, len(reranked_results))

        # Stage 7: Context construction
        context_str = self._build_context(reranked_results)

        # Stage 8: LLM
        llm      = self._get_llm()
        provider = config.LLM_PROVIDER
        prompt_text = ""

        t = time.perf_counter()
        if llm is not None:
            logger.info("[Stage 8][%s] Invoking LLM (provider=%s)", request_id, provider)
            history = self._trim_history(history) if history else history
            prompt = self._get_prompt(has_history=bool(history))
            chain  = prompt | llm | StrOutputParser()
            try:
                inputs = {"context": context_str, "question": query}
                if history:
                    inputs["history"] = history
                prompt_text = prompt.format(**inputs)
                answer = chain.invoke(inputs)
                logger.info("[Stage 9][%s] LLM answer generated (%d chars)", request_id, len(answer))
            except Exception as exc:
                logger.error("[Stage 8][%s] LLM invocation error: %s — using extractive fallback",
                             request_id, exc)
                answer   = self._extractive_fallback(query, reranked_results)
                provider = "extractive_fallback"
        else:
            logger.info("[Stage 8][%s] No LLM available — using extractive fallback", request_id)
            answer   = self._extractive_fallback(query, reranked_results)
            provider = "extractive_fallback"
        timings["llm"] = round((time.perf_counter() - t) * 1000, 2)

        answer    = self._ensure_citations(answer, reranked_results)
        citations = self._extract_citations(answer)

        prompt_tokens, est_p = self._count_tokens(prompt_text) if prompt_text else (0, False)
        completion_tokens, est_c = self._count_tokens(answer)
        timings["total"] = round((time.perf_counter() - t_start) * 1000, 2)
        logger.info("[Stage 10][%s] Done in %.0f ms — %d citations",
                    request_id, timings["total"], len(citations))

        metrics = {
            "request_id": request_id,
            "cache_hit": False,
            "retrieval_cache_hit": detail["from_cache"],
            "timings_ms": timings,
            "retrieved_chunks": len(hybrid_results),
            "final_chunks": len(reranked_results),
            "tokens": {
                "prompt": prompt_tokens,
                "completion": completion_tokens,
                "total": prompt_tokens + completion_tokens,
                "estimated": est_p or est_c,
            },
        }

        payload = {
            "query":               query,
            "answer":              answer,
            "citations":           citations,
            "retrieved_documents": self._format_hybrid_results(hybrid_results),
            "reranked_documents":  self._format_reranked_results(reranked_results),
            "provider":            provider,
            "cached":              False,
            "metrics":             metrics,
            "debug":               self._build_debug_info(request_id, provider),
        }

        if query_embedding:
            # Store without per-request metrics — fresh ones are attached on
            # every cache hit.
            cache_entry = {k: v for k, v in payload.items() if k not in ("metrics", "debug")}
            self.cache.add(query_embedding, cache_entry)

        return payload

    def answer_question_stream(self, query: str, history: str = ""):
        """
        Full RAG pipeline yielding chunks for Server-Sent Events (SSE) with
        stage logging, per-stage timings, and token accounting.
        """
        request_id = uuid.uuid4().hex[:8]
        t_start = time.perf_counter()
        timings: Dict[str, float] = {}
        logger.info("[Stage 1/STREAM][%s] Request received — query: %r", request_id, query[:80])

        # Stage 2: Query embedding + semantic cache check
        if self.retriever.embeddings:
            t = time.perf_counter()
            query_embedding = self.retriever.embed_query_cached(query)
            timings["embedding"] = round((time.perf_counter() - t) * 1000, 2)

            self.cache.sync_index_version(self.retriever.index_version)
            t = time.perf_counter()
            cached_payload = self.cache.check(query_embedding)
            timings["cache_check"] = round((time.perf_counter() - t) * 1000, 2)

            if cached_payload:
                logger.info("[Stage 2/STREAM][%s] Cache HIT — streaming cached answer", request_id)
                timings["total"] = round((time.perf_counter() - t_start) * 1000, 2)
                metrics = {
                    "request_id": request_id,
                    "cache_hit": True,
                    "retrieval_cache_hit": False,
                    "timings_ms": timings,
                    "retrieved_chunks": len(cached_payload.get("retrieved_documents", [])),
                    "final_chunks": len(cached_payload.get("reranked_documents", [])),
                    "tokens": {"prompt": 0, "completion": 0, "total": 0, "estimated": False},
                }
                debug = self._build_debug_info(
                    request_id, cached_payload.get("provider", config.LLM_PROVIDER))
                yield {
                    "type": "metadata",
                    "data": {
                        "retrieved_documents": cached_payload.get("retrieved_documents", []),
                        "reranked_documents":  cached_payload.get("reranked_documents", []),
                        "provider":            cached_payload.get("provider", "unknown"),
                        "cached":              True,
                    }
                }
                yield {"type": "chunk", "content": cached_payload["answer"]}
                yield {
                    "type": "done",
                    "data": {
                        "answer": cached_payload["answer"],
                        "citations": cached_payload["citations"],
                        "cached": True,
                        "metrics": metrics,
                        "debug": debug,
                    }
                }
                return
            logger.info("[Stage 2/STREAM][%s] Cache MISS", request_id)
        else:
            query_embedding = None

        # Stages 3-5: Hybrid retrieval with real scores
        t = time.perf_counter()
        detail = self.retriever.retrieve_detailed(
            query, top_k=config.TOP_K_RETRIEVAL, query_embedding=query_embedding)
        hybrid_results = detail["fused"]
        timings["bm25"]      = detail["timings_ms"]["bm25"]
        timings["vector"]    = detail["timings_ms"]["vector"]
        timings["fusion"]    = detail["timings_ms"]["fusion"]
        timings["retrieval"] = round((time.perf_counter() - t) * 1000, 2)
        logger.info("[Stage 3-5/STREAM][%s] Retrieved %d hybrid documents", request_id, len(hybrid_results))

        # Stage 6: Reranking
        t = time.perf_counter()
        reranked_results = self.reranker.rerank(query, hybrid_results, top_k=config.TOP_K_RERANK)
        timings["rerank"] = round((time.perf_counter() - t) * 1000, 2)
        logger.info("[Stage 6/STREAM][%s] Reranked to top %d documents", request_id, len(reranked_results))

        # Stage 7: Prompt
        context_str = self._build_context(reranked_results)
        llm         = self._get_llm()
        provider    = config.LLM_PROVIDER

        # Yield metadata to frontend immediately so citations are available before LLM finishes
        yield {
            "type": "metadata",
            "data": {
                "retrieved_documents": self._format_hybrid_results(hybrid_results),
                "reranked_documents":  self._format_reranked_results(reranked_results),
                "provider":            provider,
            }
        }

        full_answer = ""
        prompt_text = ""

        # Stage 8: LLM inference
        t = time.perf_counter()
        if llm is not None:
            logger.info("[Stage 8/STREAM][%s] Streaming from LLM (provider=%s)", request_id, provider)
            history = self._trim_history(history) if history else history
            prompt = self._get_prompt(has_history=bool(history))
            chain  = prompt | llm | StrOutputParser()
            try:
                inputs = {"context": context_str, "question": query}
                if history:
                    inputs["history"] = history
                prompt_text = prompt.format(**inputs)

                for chunk in chain.stream(inputs):
                    full_answer += chunk
                    yield {"type": "chunk", "content": chunk}
                logger.info("[Stage 9/STREAM][%s] LLM streaming complete (%d chars)",
                            request_id, len(full_answer))
            except Exception as exc:
                logger.error("[Stage 8/STREAM][%s] LLM stream error: %s — falling back", request_id, exc)
                fallback = self._extractive_fallback(query, reranked_results)
                full_answer = fallback
                provider = "extractive_fallback"
                yield {"type": "chunk", "content": fallback}
        else:
            logger.info("[Stage 8/STREAM][%s] No LLM — using extractive fallback", request_id)
            fallback = self._extractive_fallback(query, reranked_results)
            full_answer = fallback
            provider = "extractive_fallback"
            yield {"type": "chunk", "content": fallback}
        timings["llm"] = round((time.perf_counter() - t) * 1000, 2)

        # Stage 9: Citation enforcement
        full_answer = self._ensure_citations(full_answer, reranked_results)
        citations   = self._extract_citations(full_answer)

        prompt_tokens, est_p = self._count_tokens(prompt_text) if prompt_text else (0, False)
        completion_tokens, est_c = self._count_tokens(full_answer)
        timings["total"] = round((time.perf_counter() - t_start) * 1000, 2)
        logger.info("[Stage 10/STREAM][%s] Done in %.0f ms — %d citations",
                    request_id, timings["total"], len(citations))

        metrics = {
            "request_id": request_id,
            "cache_hit": False,
            "retrieval_cache_hit": detail["from_cache"],
            "timings_ms": timings,
            "retrieved_chunks": len(hybrid_results),
            "final_chunks": len(reranked_results),
            "tokens": {
                "prompt": prompt_tokens,
                "completion": completion_tokens,
                "total": prompt_tokens + completion_tokens,
                "estimated": est_p or est_c,
            },
        }

        payload = {
            "query":               query,
            "answer":              full_answer,
            "citations":           citations,
            "retrieved_documents": self._format_hybrid_results(hybrid_results),
            "reranked_documents":  self._format_reranked_results(reranked_results),
            "provider":            provider,
            "cached":              False,
        }

        if query_embedding:
            self.cache.add(query_embedding, payload)

        yield {
            "type": "done",
            "data": {
                "answer": full_answer,
                "citations": citations,
                "cached": False,
                "metrics": metrics,
                "debug": self._build_debug_info(request_id, provider),
            }
        }


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
rag_chain_instance = RAGChain()


# ---------------------------------------------------------------------------
# Quick smoke-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    res = rag_chain_instance.answer_question(
        "What is the rotation policy for KMS Customer Managed Keys?"
    )
    print("\n=== Test Chain Result ===")
    print("Provider :", res["provider"])
    print("Answer   :", res["answer"])
    print("Citations:", res["citations"])
