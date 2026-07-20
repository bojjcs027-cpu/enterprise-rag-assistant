# OmniCorp Enterprise RAG Assistant

Production "Ask My Docs" Retrieval-Augmented Generation system: hybrid
retrieval (FAISS dense + BM25 sparse, fused with Reciprocal Rank Fusion),
cross-encoder reranking, cited answers, JWT authentication with RBAC, an
enterprise knowledge library with background indexing, and a built-in
evaluation suite gated in CI.

## Features

- **Hybrid retrieval** — sentence-transformers embeddings + FAISS, Okapi BM25, RRF fusion, cross-encoder rerank
- **LLM backends** — Gemini / OpenAI / local flan-t5, with an extractive fallback when no model is reachable
- **Grounded answers** — enforced inline citations `[file.md#Section, page N]`, per-stage timings, token accounting
- **Streaming** — Server-Sent Events chat endpoint, semantic answer cache + retrieval/embedding LRU caches
- **Auth** — JWT access tokens, rotating refresh tokens with reuse detection, first-user-is-admin bootstrap, RBAC, login/signup rate limiting
- **Knowledge library** — upload .md/.txt/.pdf/.docx (validated, ≤25 MB), background chunk→embed→index with status stepper, admin delete
- **Observability** — unauthenticated `/api/health` probe, `/api/debug-retrieve` per-stage diagnostics
- **Evaluation** — recall/MRR/citation precision-recall/semantic similarity/faithfulness over `data/eval_dataset.json`, CI gate (`src/run_ci.py`)

## Screenshots

> _Placeholders — drop images into `repo-assets/` and update the paths._

| Chat with citations | Retrieval debugger | Evaluation dashboard |
|---|---|---|
| ![Chat](repo-assets/screenshot-chat.png) | ![Debugger](repo-assets/screenshot-debugger.png) | ![Evaluation](repo-assets/screenshot-eval.png) |

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design and pipeline internals
- [API.md](API.md) — full endpoint reference with payload shapes
- [DEPLOYMENT.md](DEPLOYMENT.md) — Docker, PostgreSQL, env vars, operations, troubleshooting
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, tests, conventions

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
| `LLM_PROVIDER` | `local` | `local`, `gemini`, or `openai` |
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
| `DELETE /api/library/{id}` | admin | remove document, rebuild indexes |
| `GET /api/debug-retrieve` | user | per-stage retrieval diagnostics |
| `POST /api/evaluate` | admin | run evaluation suite |

Interactive docs at `/docs` (Swagger UI).

## Architecture

```
static/            single-page dashboard (vanilla JS)
src/
  app.py           FastAPI app, lifespan model warm-up, chat + admin endpoints
  retriever.py     hybrid retrieval: FAISS + BM25 + RRF, LRU caches
  reranker.py      cross-encoder rerank (graceful pass-through on failure)
  chain.py         RAG orchestration, LLM selection, semantic cache, citations
  document_loader.py  markdown/txt/pdf/docx chunking with section metadata
  evaluator.py     metric suite + history
  auth/            JWT + refresh rotation + RBAC (router/service/repository)
  documents/       knowledge library (upload pipeline, status tracking)
alembic/           database migrations (`alembic upgrade head`)
tests/             pytest suite
```

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
