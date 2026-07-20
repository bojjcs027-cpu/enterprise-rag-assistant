# OmniCorp Enterprise RAG Assistant

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Python](https://img.shields.io/badge/python-3.11+-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-009688?logo=fastapi&logoColor=white)
![Tests](https://img.shields.io/badge/tests-passing-brightgreen)
![CI](https://img.shields.io/badge/CI-RAG%20eval%20gated-success)
![License](https://img.shields.io/badge/license-MIT-green)

Production "Ask My Docs" Retrieval-Augmented Generation system: hybrid
retrieval (FAISS dense + BM25 sparse, fused with Reciprocal Rank Fusion),
cross-encoder reranking, cited answers, JWT authentication with RBAC, an
enterprise knowledge library with incremental background indexing,
Prometheus/Grafana observability, and a built-in evaluation suite gated in
CI.

![Architecture](repo-assets/architecture.png)
*Architecture diagram placeholder — see [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for live Mermaid diagrams.*

## Features

- **Hybrid retrieval** — sentence-transformers embeddings + FAISS, Okapi BM25, RRF fusion, cross-encoder rerank
- **Incremental indexing** — uploads embed only the new files; deletes remove only that file's vectors; full rebuild kept as fallback
- **LLM backends** — Claude / Gemini / OpenAI / local flan-t5, switchable via `.env` alone, with an extractive fallback when no model is reachable
- **Grounded answers** — enforced inline citations `[file.md#Section, page N]`, per-stage timings, token accounting
- **Streaming** — Server-Sent Events chat endpoint, semantic answer cache + retrieval/embedding LRU caches
- **Redis (optional)** — shared semantic cache, retrieval cache L2, and rate limiter across workers, with automatic in-memory fallback
- **Auth** — JWT access tokens, rotating refresh tokens with reuse detection, first-user-is-admin bootstrap, RBAC, login/signup rate limiting
- **Knowledge library** — upload .md/.txt/.pdf/.docx (validated, ≤25 MB), background chunk→embed→index with status stepper, admin delete
- **Observability** — `/api/health` probe, Prometheus `/metrics`, provisioned Grafana dashboard, `/api/debug-retrieve` per-stage diagnostics
- **Evaluation** — recall/MRR/citation precision-recall/semantic similarity/faithfulness over `data/eval_dataset.json`, CI gate (`src/run_ci.py`)

## Screenshots

> _Placeholders — drop images into `repo-assets/` and update the paths._

| Chat with citations | Retrieval debugger | Evaluation dashboard |
|---|---|---|
| ![Chat](repo-assets/screenshot-chat.png) | ![Debugger](repo-assets/screenshot-debugger.png) | ![Evaluation](repo-assets/screenshot-eval.png) |

## Documentation

- [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) — Mermaid architecture, auth/upload/retrieval flows, DB schema, deployment topology
- [ARCHITECTURE.md](ARCHITECTURE.md) — system design and pipeline internals
- [API_REFERENCE.md](API_REFERENCE.md) — every endpoint with request/response examples and error codes
- [DEPLOYMENT.md](DEPLOYMENT.md) — Docker, PostgreSQL, Redis, nginx/SSL, scaling, troubleshooting
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, tests, conventions
- [RELEASE_NOTES.md](RELEASE_NOTES.md) — v1.0.0 changelog and roadmap

## Quick start

```bash
pip install -r requirements.txt
cp .env.example .env      # then set JWT_SECRET_KEY (see below) and, optionally, an LLM API key
python run.py --server    # http://127.0.0.1:8000
```

Generate a JWT secret:

```bash
python -c "import secrets; print(secrets.token_urlsafe(64))"
```

First signup in the UI becomes the **admin** account.

### Other commands

```bash
python run.py --reindex   # rebuild FAISS + BM25 indexes from data/
python run.py --eval      # run the evaluation suite
python -m src.run_ci      # CI gate: reindex + eval + threshold check
pytest tests/             # unit/integration tests
```

### Docker

```bash
export JWT_SECRET_KEY=$(python -c "import secrets; print(secrets.token_urlsafe(64))")
docker compose up --build
```

Documents, indexes, and databases persist in the `rag_data` volume.

## Configuration

All settings come from `.env` (see [.env.example](.env.example)). Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `local` | `local`, `claude`, `gemini`, or `openai` |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Claude model when provider is `claude` |
| `REDIS_URL` | empty (disabled) | shared caches + rate limits, auto-fallback to memory |
| `JWT_SECRET_KEY` | — (required) | signs access tokens |
| `DATABASE_URL` | SQLite in `data/` | point at PostgreSQL in production |
| `CORS_ORIGINS` | localhost dev origins | comma-separated allow-list |
| `RATE_LIMIT_AUTH_ATTEMPTS` | `10` | login/signup attempts per IP per window |
| `TOP_K_RETRIEVAL` / `TOP_K_RERANK` | `6` / `3` | pipeline depth |

## API overview

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | liveness/readiness (503 while warming up) |
| `POST /api/auth/signup·login·refresh·logout` | none (rate-limited) | account + session lifecycle |
| `GET/PUT /api/auth/me` | user | profile, password change |
| `POST /api/chat` | user | RAG answer (set `"stream": true` for SSE) |
| `GET /api/chat/history` | user | per-user conversation history |
| `GET /api/library` | user | document list + search |
| `POST /api/library/upload` | admin | upload + background indexing (poll `/api/library/status`) |
| `DELETE /api/library/{id}` | admin | remove document + its chunks (incremental) |
| `GET /metrics` | none (firewall it) | Prometheus metrics |
| `GET /api/debug-retrieve` | user | per-stage retrieval diagnostics |
| `POST /api/evaluate` | admin | run evaluation suite |

Interactive docs at `/docs` (Swagger UI).

## Folder structure

```
static/              single-page dashboard (vanilla JS, no build step)
src/
  app.py             FastAPI app, lifespan warm-up, chat endpoints, /metrics
  retriever.py       hybrid retrieval: FAISS + BM25 + RRF, incremental indexing, caches
  reranker.py        cross-encoder rerank (graceful pass-through on failure)
  chain.py           RAG orchestration, LLM selection, semantic cache, citations
  document_loader.py markdown/txt/pdf/docx chunking with section metadata
  evaluator.py       metric suite + history
  metrics.py         Prometheus instrumentation
  redis_backend.py   optional shared Redis connection (auto-fallback)
  auth/              JWT + refresh rotation + RBAC + rate limiting
  documents/         knowledge library (upload pipeline, status tracking)
monitoring/          Prometheus scrape config + provisioned Grafana dashboard
alembic/             database migrations (`alembic upgrade head`)
tests/               pytest suite
data/                source documents + built indexes + local DBs (gitignored artifacts)
```

## Performance

Measured on a modest laptop (CPU-only, 30-chunk corpus):

| Operation | Latency |
|---|---|
| Health probe | ~3 ms |
| Hybrid retrieval (BM25 + FAISS + RRF) | ~113 ms cold, ~0.02 ms cached |
| Cross-encoder rerank (CPU) | 170–300 ms |
| Local LLM generation (flan-t5, CPU) | ~7–9 s |
| Full chat via semantic cache | < 1 ms |
| Incremental upload (1 doc) | seconds (embeds only the new chunks) |

Cloud providers (`claude` / `gemini` / `openai`) or a GPU cut generation
latency roughly 10×. Grafana ships with p95 panels for every stage.

## FAQ

**Do I need an API key?** No — the default `local` provider runs
google/flan-t5-base on CPU. Set `LLM_PROVIDER=claude|gemini|openai` plus the
matching key for much better answers.

**Do I need Redis?** No. Everything runs in-memory by default. Redis is an
opt-in for multi-worker deployments and survives restarts; if it's down,
the app falls back to memory automatically.

**How do I make someone an admin?** The first account created is the admin.
Additional role management is a roadmap item — see RELEASE_NOTES.md.

**Does uploading rebuild everything?** No — new documents are embedded and
added incrementally; deletes remove only that document's vectors. A full
rebuild happens only as a correctness fallback (or via `run.py --reindex`).

**Can I use PostgreSQL?** Yes — set `DATABASE_URL` and run
`alembic upgrade head`. SQLite remains fine for a single instance.

**Where do answers' citations come from?** Chunk metadata
(`file#Section, page N`) is injected into the prompt; the model must cite,
and uncited answers get the top sources auto-appended, so answers are never
unattributed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/api/health` returns 503 for minutes after start | first-boot model downloads — watch the logs, then it flips to 200 |
| 500s mentioning JWT | set `JWT_SECRET_KEY` in `.env` |
| CORS errors in the browser | add your frontend origin to `CORS_ORIGINS` |
| `WinError 1114` loading `c10.dll` (Windows) | torch DLL flake — `run.py` and `tests/conftest.py` pre-import torch as a workaround; run from an interactive terminal if it persists |
| `No module named 'numpy._core'` | numpy < 2 with faiss-cpu ≥ 1.14 — reinstall with `pip install -r requirements.txt` |
| 429 on login | auth rate limiter — wait `Retry-After` seconds or tune `RATE_LIMIT_AUTH_*` |

More in [DEPLOYMENT.md](DEPLOYMENT.md#7-troubleshooting).

## License

MIT — see [LICENSE](LICENSE).
