import json
import logging
from pathlib import Path

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from src import config, chain, retriever, evaluator, database, metrics
from src.db import engine, Base
from src.auth.router import router as auth_router
from src.auth.dependencies import CurrentUser, AdminUser
from src.auth import models as auth_models  # noqa: F401 — registers ORM models on Base
from src.documents.router import router as library_router
from src.documents import models as document_models  # noqa: F401 — registers ORM models on Base
from src.documents.service import library_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Pre-loads heavy models (Embeddings, Reranker, LLM) into memory on Uvicorn worker startup.
    This resolves the '0 chunks indexed' bug and prevents the first query from timing out.
    """
    logger.info("Starting up OmniCorp RAG API worker...")
    try:
        database.init_db()
        # Canonical schema management is Alembic (alembic upgrade head);
        # create_all is an idempotent dev-convenience safety net.
        Base.metadata.create_all(bind=engine)
        await run_in_threadpool(retriever.retriever_instance.initialize)
        if config.LLM_PROVIDER == "local":
            await run_in_threadpool(chain.rag_chain_instance._get_local_llm)
        await run_in_threadpool(retriever.reranker_instance.initialize)
        # Reconcile library metadata with files on disk (registers seed docs,
        # drops stale rows, refreshes chunk counts).
        await run_in_threadpool(library_service.sync_filesystem)
        logger.info("All RAG models initialized successfully.")
    except Exception as e:
        logger.exception(f"Failed to initialize models on startup: {e}")
    yield

app = FastAPI(
    title="OmniCorp RAG Assistant",
    description="Enterprise 'Ask My Docs' Production Retrieval-Augmented Generation (RAG) System",
    version="2.0.0",
    lifespan=lifespan,
)

# Allowed origins come from CORS_ORIGINS (comma-separated env var).
# A wildcard with credentials is rejected by browsers, so origins are
# always an explicit list here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Prometheus: request count / error count / latency per route template.
# Uses the matched route path (not the raw URL) to keep label cardinality low.
@app.middleware("http")
async def prometheus_middleware(request, call_next):
    import time as _time
    start = _time.perf_counter()
    try:
        response = await call_next(request)
        status_code = response.status_code
    except Exception:
        status_code = 500
        raise
    finally:
        route = request.scope.get("route")
        path = getattr(route, "path", None) or "unmatched"
        method = request.method
        metrics.HTTP_REQUESTS.labels(method=method, path=path,
                                     status=str(status_code)).inc()
        metrics.HTTP_LATENCY.labels(method=method, path=path).observe(
            _time.perf_counter() - start)
        if status_code >= 500:
            metrics.HTTP_ERRORS.labels(method=method, path=path).inc()
    return response


# Authentication endpoints (/api/auth/*)
app.include_router(auth_router)
# Knowledge Library endpoints (/api/library/*)
app.include_router(library_router)


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    query: str
    stream: bool = False
    history: str = ""
    session_id: str = "default_session"

class ChatResponse(BaseModel):
    query: str
    answer: str
    citations: List[str]
    retrieved_documents: List[Dict[str, Any]]
    reranked_documents: List[Dict[str, Any]]
    provider: str
    cached: bool = False
    metrics: Optional[Dict[str, Any]] = None   # per-stage timings, tokens, cache info
    debug: Optional[Dict[str, Any]] = None     # models, provider, k-values, request id

class ErrorResponse(BaseModel):
    detail: str


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health_check():
    """
    Unauthenticated liveness/readiness probe for load balancers and monitoring.
    Reports whether the retrieval index and the database are actually usable;
    returns 503 while the worker is still warming up.
    """
    from sqlalchemy import text

    index_ready = retriever.retriever_instance._initialized
    db_ok = True
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        db_ok = False

    ready = index_ready and db_ok
    body = {
        "status": "ok" if ready else "starting",
        "index_ready": index_ready,
        "database_ok": db_ok,
        "version": app.version,
    }
    if not ready:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=503, content=body)
    return body


@app.get("/metrics")
async def prometheus_metrics():
    """Prometheus scrape endpoint. Unauthenticated by design — restrict at
    the network layer (it is not exposed through the dashboard)."""
    from fastapi.responses import Response
    payload, content_type = metrics.render()
    return Response(content=payload, media_type=content_type)


@app.get("/api/status")
async def get_status(user: CurrentUser):
    """
    Returns the current system status: active LLM provider, models in use,
    and the number of indexed document chunks.
    Used by the frontend to show the provider pill without relying on eval history.
    """
    docs_count = len(retriever.retriever_instance.all_documents)
    provider   = config.LLM_PROVIDER

    # Detect whether we are actually running a real model or a fallback
    if provider == "gemini" and not config.GEMINI_API_KEY:
        effective_provider = "local"
    elif provider == "openai" and not config.OPENAI_API_KEY:
        effective_provider = "local"
    else:
        effective_provider = provider

    return {
        "llm_provider":      effective_provider,
        "configured_provider": provider,
        "local_model":       config.LOCAL_LLM_MODEL,
        "embedding_model":   config.EMBEDDING_MODEL_NAME,
        "rerank_model":      config.RERANK_MODEL_NAME,
        "top_k_retrieval":   config.TOP_K_RETRIEVAL,
        "top_k_rerank":      config.TOP_K_RERANK,
        "documents_indexed": docs_count,
        "status":            "operational",
    }


@app.get("/api/chat/history")
async def get_chat_history_endpoint(user: CurrentUser, limit: int = 50):
    """Retrieves the chat history for the authenticated user."""
    try:
        # Sessions are keyed by user id server-side so users can never read
        # each other's conversations, regardless of what the client sends.
        history = await run_in_threadpool(database.get_chat_history, f"user:{user.id}", limit)
        return {"history": history}
    except Exception as exc:
        logger.exception("Failed to fetch chat history")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch chat history: {exc}",
        )

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest, user: CurrentUser):
    """
    Main RAG chat endpoint. If stream=True, returns Server-Sent Events (SSE).
    Otherwise returns a complete JSON ChatResponse.
    """
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    # Server-authoritative session id — the client-supplied one is ignored.
    session_id = f"user:{user.id}"
    metrics.record_chat_activity(user.id, session_id)

    if request.stream:
        try:
            from sse_starlette.sse import EventSourceResponse
        except ImportError:
            raise HTTPException(status_code=500, detail="sse-starlette is required for streaming.")
        
        def event_generator():
            try:
                # EventSourceResponse detects this sync generator and will
                # automatically iterate it in a threadpool (using anyio.to_thread.run_sync).
                # This prevents the blocking LLM from freezing the asyncio event loop.
                database.save_message(session_id, "user", request.query)
                generator = chain.rag_chain_instance.answer_question_stream(request.query, request.history)

                full_answer = ""
                for item in generator:
                    if item.get("type") == "chunk":
                        full_answer += item.get("content", "")
                    elif item.get("type") == "done":
                        data = item.get("data", {})
                        database.save_message(session_id, "assistant", data.get("answer", full_answer))
                        m = data.get("metrics") or {}
                        metrics.observe_pipeline(
                            m.get("timings_ms", {}), m.get("cache_hit", False),
                            m.get("retrieval_cache_hit", False),
                            (data.get("debug") or {}).get("llm_provider", "unknown"))
                    yield {"data": json.dumps(item)}
            except Exception as e:
                logger.exception("Stream failed")
                yield {"event": "error", "data": str(e)}

        return EventSourceResponse(event_generator())
    else:
        try:
            database.save_message(session_id, "user", request.query)
            # Run blocking RAG chain in a thread pool to avoid blocking the asyncio event loop
            result = await run_in_threadpool(
                chain.rag_chain_instance.answer_question,
                request.query,
                request.history
            )
            database.save_message(session_id, "assistant", result["answer"])
            m = result.get("metrics") or {}
            metrics.observe_pipeline(
                m.get("timings_ms", {}), m.get("cache_hit", False),
                m.get("retrieval_cache_hit", False), result.get("provider", "unknown"))
            return ChatResponse(**result)
        except Exception as exc:
            logger.exception("RAG Chain execution failed")
            raise HTTPException(
                status_code=500,
                detail=f"RAG Chain execution failed: {exc}",
            )


@app.get("/api/debug-retrieve")
async def debug_retrieve_endpoint(user: CurrentUser, query: str = Query(..., min_length=1)):
    """
    Detailed retrieval diagnostic with real scores and timings.

    Runs the actual hybrid pipeline once (BM25 with Okapi scores, FAISS with
    L2 distances, RRF fusion, cross-encoder rerank) and returns every stage
    side-by-side, plus per-stage execution times.
    """
    import time as _time
    try:
        def run_pipeline():
            retriever.retriever_instance.initialize()
            t0 = _time.perf_counter()
            detail = retriever.retriever_instance.retrieve_detailed(
                query, top_k=config.TOP_K_RETRIEVAL
            )
            t1 = _time.perf_counter()
            reranked = retriever.reranker_instance.rerank(
                query, detail["fused"], top_k=config.TOP_K_RERANK
            )
            t2 = _time.perf_counter()
            return detail, reranked, (t1 - t0), (t2 - t1)

        detail, reranked_results, t_retrieval, t_rerank = await run_in_threadpool(run_pipeline)

        def base(doc):
            return {
                "content":  doc.page_content,
                "source":   doc.metadata.get("source"),
                "section":  doc.metadata.get("section"),
                "chunk_id": doc.metadata.get("chunk_id"),
                "page":     doc.metadata.get("page", 1),
            }

        bm25_out = [
            {**base(it["doc"]), "bm25_score": it["bm25_score"]}
            for it in detail["bm25"]
        ]
        vector_out = [
            {**base(it["doc"]),
             "vector_distance":   it["vector_distance"],
             "vector_similarity": it["vector_similarity"]}
            for it in detail["vector"]
        ]
        rrf_out = [
            {**base(it["doc"]),
             "vector_rank":       it["vector_rank"],
             "bm25_rank":         it["bm25_rank"],
             "score":             it["score"],
             "bm25_score":        it.get("bm25_score"),
             "vector_similarity": it.get("vector_similarity")}
            for it in detail["fused"]
        ]
        reranked_out = [
            {**base(it["doc"]),
             "vector_rank":       it["vector_rank"],
             "bm25_rank":         it["bm25_rank"],
             "score":             it["score"],
             "bm25_score":        it.get("bm25_score"),
             "vector_similarity": it.get("vector_similarity"),
             "rerank_score":      it["rerank_score"],
             "confidence":        chain.rag_chain_instance._sigmoid(it["rerank_score"]),
             "final_rank":        rank}
            for rank, it in enumerate(reranked_results, start=1)
        ]

        return {
            "query":    query,
            "bm25":     bm25_out,
            "vector":   vector_out,
            "rrf":      rrf_out,
            "reranked": reranked_out,
            "timings_ms": {
                "bm25":      detail["timings_ms"]["bm25"],
                "vector":    detail["timings_ms"]["vector"],
                "fusion":    detail["timings_ms"]["fusion"],
                "retrieval": round(t_retrieval * 1000, 2),
                "rerank":    round(t_rerank * 1000, 2),
                "total":     round((t_retrieval + t_rerank) * 1000, 2),
            },
            "retrieval_cache_hit": detail["from_cache"],
        }

    except Exception as exc:
        logger.exception("Diagnostic retrieval failed")
        raise HTTPException(
            status_code=500,
            detail=f"Diagnostic retrieval failed: {exc}",
        )


# NOTE: the legacy /api/documents endpoints were removed in the production
# audit — /api/library supersedes them (same operations plus metadata
# tracking, upload validation, and status reporting).


@app.post("/api/evaluate")
async def trigger_evaluation(admin: AdminUser):
    """Triggers the evaluation pipeline and returns summary metrics."""
    try:
        summary = evaluator.evaluator_instance.run_evaluation()
        return summary
    except Exception as exc:
        logger.exception("Evaluation failed")
        raise HTTPException(
            status_code=500,
            detail=f"Evaluation failed: {exc}",
        )


@app.get("/api/evaluate/history")
async def get_evaluation_history(user: CurrentUser):
    """Retrieves list of past evaluation runs."""
    try:
        return evaluator.evaluator_instance.get_history()
    except Exception as exc:
        logger.exception("Failed to retrieve evaluation history")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve evaluation history: {exc}",
        )


# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------

static_dir = Path(__file__).resolve().parent.parent / "static"
static_dir.mkdir(exist_ok=True)


@app.get("/")
async def read_index():
    index_file = static_dir / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {
        "message": (
            "Welcome to OmniCorp RAG API. "
            "Place index.html in the static/ folder to view the dashboard."
        )
    }


# Mount static files (JS, CSS, images)
app.mount("/static", StaticFiles(directory=static_dir), name="static")
