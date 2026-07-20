# Deployment Guide

## 1. Docker Compose (recommended)

```bash
# Required secret — generate once and store safely
export JWT_SECRET_KEY=$(python -c "import secrets; print(secrets.token_urlsafe(64))")

# Optional: cloud LLM
export LLM_PROVIDER=gemini
export GEMINI_API_KEY=...

docker compose up --build -d
curl http://localhost:8000/api/health   # 503 while warming, then 200
```

- Documents, indexes, auth DB, and chat history persist in the `rag_data`
  volume.
- The image healthcheck polls `/api/health` (120 s start period — model
  loading takes a while on first boot).
- First model download requires outbound access to huggingface.co; models
  are cached in the container afterwards (bake them into the image for
  air-gapped deploys).

## 2. Bare metal / VM

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env    # set JWT_SECRET_KEY, provider keys, CORS_ORIGINS
python run.py --server
```

Put a TLS-terminating reverse proxy (nginx/Caddy) in front and point
`CORS_ORIGINS` at your public origin. Run one worker per instance — the
in-memory rate limiter and semantic cache are per-process.

## 3. PostgreSQL

SQLite is the default and fine for a single instance. For PostgreSQL:

```bash
DATABASE_URL=postgresql+psycopg2://user:pass@host:5432/omnicorp
pip install psycopg2-binary
alembic upgrade head        # creates users, refresh_tokens, documents
```

Chat history currently uses a local SQLite file (`data/chat_history.db`)
independent of DATABASE_URL.

## 4. Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET_KEY` | **yes** | — | HS256 signing key; auth fails closed without it |
| `LLM_PROVIDER` | no | `local` | `local` / `gemini` / `openai` |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | with provider | — | falls back to local when missing |
| `LOCAL_LLM_MODEL` | no | `google/flan-t5-base` | any HF seq2seq model |
| `DATABASE_URL` | no | SQLite in `data/` | PostgreSQL in production |
| `CORS_ORIGINS` | production | localhost origins | comma-separated allow-list |
| `HOST` / `PORT` | no | `127.0.0.1` / `8000` | `0.0.0.0` inside containers |
| `RATE_LIMIT_AUTH_ATTEMPTS` / `_WINDOW_SECONDS` | no | `10` / `60` | login/signup throttle |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | no | `500` / `50` | reindex after changing |
| `TOP_K_RETRIEVAL` / `TOP_K_RERANK` | no | `6` / `3` | pipeline depth |
| `ACCESS_TOKEN_EXPIRE_MINUTES` / `REFRESH_TOKEN_EXPIRE_DAYS` | no | `30` / `30` | session lifetimes |

## 5. Operations

- **Probes**: liveness + readiness → `GET /api/health` (unauthenticated).
- **Logs**: structured stage logs to stdout (`[Stage N][request_id] …`);
  point your collector at container stdout.
- **Reindex**: `python run.py --reindex` (offline) or upload/delete via the
  library API (online, background).
- **Evaluation**: `python run.py --eval` or `POST /api/evaluate`; CI gate is
  `python -m src.run_ci`.
- **Backups**: the `data/` directory (or `rag_data` volume) contains
  everything: source docs, indexes, auth DB, chat history, eval history.
  Indexes are rebuildable; the databases and source docs are not.
- **First run**: the first signup becomes admin — create your admin account
  immediately after deploying.

## 6. Scaling notes

Current design targets a single instance. Before scaling horizontally:
move the rate limiter and semantic cache to Redis, serve one shared
retrieval index (or replicate `data/` read-only), and move chat history to
the main database.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/api/health` stays 503 | models still downloading (first boot) — check logs; verify huggingface.co reachability |
| 500s mentioning JWT | `JWT_SECRET_KEY` unset |
| Browser errors calling the API from another origin | add the origin to `CORS_ORIGINS` |
| `WinError 1114` loading `c10.dll` (Windows) | torch DLL init flake — `run.py`/`conftest.py` pre-import torch; run from an interactive terminal |
| `numpy._core` import errors | numpy < 2 with faiss-cpu ≥ 1.14 — `pip install -r requirements.txt` enforces compatible floors |
| 429 on login | rate limiter — wait for `Retry-After` seconds or tune `RATE_LIMIT_AUTH_*` |
