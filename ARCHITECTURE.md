# Architecture

## Overview

Single FastAPI service serving both the JSON API and the static single-page
dashboard. Heavy models (embeddings, cross-encoder, optional local LLM) are
loaded once per worker in the lifespan hook; retrieval indexes are persisted
to disk and rebuilt on demand.

```
                ┌────────────────────────────────────────────────┐
                │                  FastAPI app                    │
                │  static/  ← dashboard (vanilla JS, no build)    │
                │                                                │
 Browser ──────►│  /api/auth/*      JWT + refresh rotation, RBAC │
                │  /api/chat        RAG pipeline (JSON or SSE)   │
                │  /api/library/*   uploads → background indexing│
                │  /api/debug-retrieve   stage-by-stage scores   │
                │  /api/evaluate    metric suite + history       │
                │  /api/health      unauthenticated probe        │
                └───────┬──────────────────┬─────────────────────┘
                        │                  │
             ┌──────────▼─────────┐   ┌────▼───────────────────┐
             │  RAG pipeline      │   │  SQL database          │
             │  (singletons)      │   │  (SQLite / PostgreSQL) │
             │                    │   │  users, refresh_tokens,│
             │  HybridRetriever   │   │  documents             │
             │  DocumentReranker  │   └────────────────────────┘
             │  RAGChain          │   ┌────────────────────────┐
             │  SemanticCache     │   │  chat_history.db       │
             └──────────┬─────────┘   │  (SQLite, per-user     │
                        │             │   sessions)            │
             ┌──────────▼─────────┐   └────────────────────────┘
             │  data/             │
             │  source docs +     │
             │  vectorstore/      │
             │  (FAISS + BM25)    │
             └────────────────────┘
```

## Query pipeline (src/chain.py)

1. **Embed query** — sentence-transformers `all-MiniLM-L6-v2`, LRU-cached.
2. **Semantic cache check** — cosine ≥ 0.92 against previous answers; hit
   returns immediately. Cache is bounded (256 entries) and cleared whenever
   the retrieval index generation changes.
3. **Hybrid retrieval** (src/retriever.py) — BM25 (Okapi, real scores) and
   FAISS (L2 distances) run over the same chunks; results merged with
   Reciprocal Rank Fusion (k=60). Exact-match retrieval LRU keyed on
   (query, top_k, index_version).
4. **Rerank** (src/reranker.py) — cross-encoder `ms-marco-MiniLM-L-6-v2`
   scores each (query, chunk) pair; top-3 kept. Pass-through fallback if the
   model cannot load.
5. **Generate** — provider order: Gemini / OpenAI (if configured) → local
   flan-t5 → extractive sentence fallback. Context blocks are prefixed with
   their citation reference; the prompt demands inline citations.
6. **Citation enforcement** — answers with no citations get the top sources
   appended; citations are extracted and returned structured.

Every stage reports real timings; responses carry `metrics` (per-stage ms,
token counts, cache flags) and `debug` (models, k-values, request id).

## Indexing pipeline (src/documents/)

Upload → validate (extension, size ≤ 25 MB, parseability, filename
sanitisation) → write to `data/` → metadata row (`UPLOADED`) → background
rebuild advances status through `CHUNKING → EMBEDDING → INDEXING →
COMPLETED` (or `FAILED` with the error). A module-level lock serialises
rebuilds. On startup, `sync_filesystem()` reconciles DB rows with files on
disk.

Chunking (src/document_loader.py): markdown is split by headers (section
names preserved for citations) then recursively to ~500 chars with 50
overlap; txt/pdf/docx get equivalent treatment. Page numbers are estimated
(~2000 chars/page) for markdown/txt and taken from the PDF loader for PDFs.

## Auth (src/auth/)

Layered router → service → repository. Access tokens are 30-minute HS256
JWTs; refresh tokens are opaque 48-byte secrets stored as SHA-256 hashes,
rotated on every use — presenting a revoked token revokes the whole family
(theft detection). First account bootstraps as admin; RBAC via dependency
(`CurrentUser` / `AdminUser`). Login/signup are rate-limited per IP
(sliding window). Password hashing is bcrypt; login timing is equalised for
unknown emails.

## Evaluation (src/evaluator.py)

Runs `data/eval_dataset.json` through the full pipeline and computes
retrieval recall, MRR, citation precision/recall, semantic similarity,
answer relevance, and an embedding-based faithfulness proxy. History is
kept in `data/eval_history.json`; `src/run_ci.py` gates CI on recall ≥ 0.80,
citation precision ≥ 0.80, similarity ≥ 0.70.

## Design decisions

- **Singletons over DI for models** — embeddings/reranker/LLM are
  process-wide by nature; SQL access uses request-scoped sessions.
- **SQLAlchemy for relational data, files for indexes** — `DATABASE_URL`
  switches SQLite → PostgreSQL without code changes (Alembic migrations);
  FAISS/BM25 are file-backed because they are rebuilt atomically as a unit.
- **Full rebuild on upload/delete** — with corpus sizes this system targets
  (hundreds of documents), a rebuild is seconds and guarantees consistency;
  incremental index mutation is the optimisation to reach for at larger
  scale.
- **No frontend build step** — vanilla JS keeps the deployment surface a
  single Python service.
