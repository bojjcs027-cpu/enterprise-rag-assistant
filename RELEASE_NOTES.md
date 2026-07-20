# Release Notes

## v1.0.0 — 2026-07-20

First production release of the OmniCorp Enterprise RAG Assistant.

### Features

- **Hybrid retrieval pipeline** — sentence-transformers + FAISS dense search,
  Okapi BM25 sparse search, Reciprocal Rank Fusion, cross-encoder reranking,
  with real per-stage scores and timings surfaced end to end.
- **Incremental indexing** — uploads embed only the new documents
  (`FAISS.add_documents`), deletes remove only that document's vectors
  (`FAISS.delete`); BM25 rebuilds from memory in milliseconds; full rebuild
  retained as the correctness fallback.
- **Four LLM providers, env-switchable** — `local` (flan-t5, no key),
  `claude` (default `claude-opus-4-8`), `gemini`, `openai`; automatic
  local fallback on missing keys and extractive fallback when no model is
  reachable. No code changes to switch.
- **Citation-enforced answers** — inline `[file#Section, page N]` references
  extracted and returned structured; uncited answers get sources appended.
- **Streaming chat** — Server-Sent Events with metadata-first delivery.
- **Caching** — bounded semantic answer cache (cos ≥ 0.92), retrieval LRU +
  optional shared Redis L2, query-embedding LRU; all invalidated on index
  changes.
- **Redis (optional)** — `REDIS_URL` enables shared semantic cache,
  retrieval cache, and rate limiter across workers, with automatic
  in-memory fallback when Redis is missing or fails.
- **Authentication** — JWT access tokens, rotating refresh tokens with
  reuse-detection (theft revokes all sessions), bcrypt with timing
  equalization, first-user-is-admin bootstrap, RBAC, per-IP rate limiting
  on login/signup.
- **Knowledge library** — validated uploads (extension, size ≤ 25 MB,
  parse-check, filename sanitization, dedupe), background processing with
  live status stepper, admin delete, startup filesystem reconciliation.
- **Observability** — unauthenticated `/api/health`, Prometheus `/metrics`
  (requests, errors, uploads, stage latencies, cache hit ratios, active
  users/conversations), provisioned Grafana dashboard + Prometheus compose
  overlay, `/api/debug-retrieve` stage-by-stage diagnostics.
- **Evaluation** — retrieval recall, MRR, citation precision/recall,
  semantic similarity, faithfulness; history tracking; CI gate with
  thresholds.
- **Deployment** — Dockerfile with healthcheck, docker-compose with
  persistent volume, Alembic migrations, SQLite→PostgreSQL via env,
  nginx/SSL guide.

### Improvements (since initial commit)

- Config-driven CORS allow-list (replaced wildcard+credentials).
- Sliding-window auth rate limiting (in-memory or Redis).
- Retrieval cache keyed on index generation; thread-safe initialization.
- Prometheus middleware with route-template labels (bounded cardinality).
- Full documentation set: SYSTEM_DESIGN, API_REFERENCE, DEPLOYMENT,
  ARCHITECTURE, CONTRIBUTING, README v1.0, MIT LICENSE.

### Bug fixes

- Chat history returned the oldest N messages instead of the most recent N.
- Semantic cache grew without bound and survived reindexes, serving answers
  that cited deleted documents — now bounded (256) and version-invalidated.
- Removed legacy `/api/documents` endpoints (duplicated `/api/library`;
  DELETE accepted backslash path traversal on Windows).
- numpy 1.x / faiss-cpu 1.14 ABI mismatch broke the vector store at startup
  — requirements now pin numpy ≥ 2 with compatible pandas/scikit floors.
- torch `c10.dll` init flake on Windows (WinError 1114) worked around by
  pre-importing torch in `run.py` and `tests/conftest.py`.

### Known limitations

- Chat history lives in a local SQLite file regardless of `DATABASE_URL` —
  multi-node deployments need session pinning until it moves to the main DB.
- Prometheus metrics are per-process (use per-worker scrape targets or
  prometheus_client multiprocess mode when running multiple workers).
- Semantic-cache Redis persistence is load-on-start / write-through — new
  entries are not live-synced between already-running workers.
- No admin UI for role management; the first account is the only admin
  unless the DB is edited directly.
- Local flan-t5-base answers are terse; cloud providers recommended for
  answer quality.

### Future roadmap

- Chat history in the main database + conversation management UI.
- Role management endpoints and admin user UI.
- Served vector DB option (pgvector/Qdrant) behind the retriever interface.
- OpenTelemetry tracing spans per pipeline stage.
- Multi-tenant workspaces with per-tenant indexes.
- Scheduled re-evaluation and metric regression alerts in Grafana.
