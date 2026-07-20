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

## 3b. Redis (optional — shared caches & rate limits)

Without Redis everything runs in-memory per process (the default; nothing
to configure). Set `REDIS_URL` to share state across restarts and workers:

```bash
docker run -d --name rag-redis -p 6379:6379 redis:7-alpine
# .env
REDIS_URL=redis://localhost:6379/0
REDIS_RETRIEVAL_TTL_SECONDS=3600
```

What moves to Redis: the semantic answer cache (persistence), a shared
retrieval-cache L2 (TTL-bounded), and the auth rate limiter (sliding window
in a sorted set, shared across workers). **Fallback is automatic** — if
Redis is unreachable at startup or errors at runtime, each consumer reverts
to its in-memory implementation and the app keeps working; a warning is
logged once.

## 3c. Monitoring (Prometheus + Grafana)

```bash
docker compose -f docker-compose.yml -f docker-compose.grafana.yml up -d
# Grafana:    http://localhost:3001  (admin / $GRAFANA_ADMIN_PASSWORD, default admin)
# Prometheus: http://localhost:9090
```

The "RAG Assistant — Overview" dashboard is provisioned automatically:
request rate, p95 latency, cache hit ratios, uploads, CPU, memory,
retrieval/rerank/LLM p95, active users/conversations, errors. The app
exposes `/metrics` unauthenticated — restrict it at the network layer.

## 3d. Reverse proxy (nginx) + SSL

Terminate TLS in front of uvicorn and forward SSE-friendly headers:

```nginx
server {
    listen 443 ssl http2;
    server_name rag.example.com;

    ssl_certificate     /etc/letsencrypt/live/rag.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rag.example.com/privkey.pem;

    client_max_body_size 30m;          # library uploads (25 MB limit + overhead)

    location /metrics { deny all; }    # scrape internally only

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE streaming (POST /api/chat with stream=true)
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
server { listen 80; server_name rag.example.com; return 301 https://$host$request_uri; }
```

Certificates: `certbot --nginx -d rag.example.com` (auto-renews). Then set
`CORS_ORIGINS=https://rag.example.com`. Note: the rate limiter keys on the
direct client IP; behind a proxy all requests share the proxy's IP, so
either enforce rate limits at nginx (`limit_req`) or run uvicorn with
`--proxy-headers` and `--forwarded-allow-ips` so the real IP is seen.

## 4. Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET_KEY` | **yes** | — | HS256 signing key; auth fails closed without it |
| `LLM_PROVIDER` | no | `local` | `local` / `claude` / `gemini` / `openai` |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` | with provider | — | falls back to local when missing |
| `ANTHROPIC_MODEL` | no | `claude-opus-4-8` | Claude model when `LLM_PROVIDER=claude` |
| `REDIS_URL` | no | empty (disabled) | shared caches + rate limits; auto-fallback to memory |
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

## 6. Scaling recommendations

- **Single node (default):** one uvicorn worker; SQLite; in-memory caches.
  Handles small-team traffic comfortably — the LLM is the bottleneck.
- **Vertical first:** CPU cores speed up rerank/LLM; GPU or a cloud
  provider (`LLM_PROVIDER=claude|gemini|openai`) cuts generation latency
  ~10×.
- **Multiple workers / instances:** set `REDIS_URL` (shared rate limits +
  caches) and `DATABASE_URL` → PostgreSQL. Chat history remains a local
  SQLite file — pin sessions to one instance or move it into the main DB
  before going multi-node.
- **Index distribution:** each instance loads the FAISS/BM25 index from its
  `data/` volume. Share a read-only volume plus one writer instance for
  uploads, or accept rebuild-per-instance at small corpus sizes.
- **Beyond that:** swap FAISS for a served vector DB (Qdrant/Weaviate/
  pgvector) behind the `HybridRetriever` interface — the API surface stays
  the same.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/api/health` stays 503 | models still downloading (first boot) — check logs; verify huggingface.co reachability |
| 500s mentioning JWT | `JWT_SECRET_KEY` unset |
| Browser errors calling the API from another origin | add the origin to `CORS_ORIGINS` |
| `WinError 1114` loading `c10.dll` (Windows) | torch DLL init flake — `run.py`/`conftest.py` pre-import torch; run from an interactive terminal |
| `numpy._core` import errors | numpy < 2 with faiss-cpu ≥ 1.14 — `pip install -r requirements.txt` enforces compatible floors |
| 429 on login | rate limiter — wait for `Retry-After` seconds or tune `RATE_LIMIT_AUTH_*` |
