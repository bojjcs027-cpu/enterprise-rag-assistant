# API Reference (v1.0)

Base URL: `http://HOST:PORT` (default `http://127.0.0.1:8000`).
Interactive docs: `/docs` (Swagger UI), `/redoc`.

## Authentication

All endpoints except `/api/health`, `/metrics`, and the auth endpoints
require a bearer token:

```
Authorization: Bearer <access_token>
```

Access tokens are 30-minute JWTs obtained from signup/login/refresh.
Refresh tokens are opaque, single-use (rotated on refresh), and valid 30
days.

## Error format

All errors return `{"detail": "human-readable message"}`.

| Code | Meaning |
|---|---|
| 400 | Invalid input (empty query, malformed ids, no accepted files) |
| 401 | Missing/invalid/expired token, bad credentials, revoked refresh token |
| 403 | Valid user but insufficient role (admin required) or deactivated account |
| 404 | Resource not found |
| 409 | Duplicate email on signup |
| 422 | Schema validation failure (pydantic detail array) |
| 429 | Rate limit exceeded — `Retry-After` header gives seconds to wait |
| 500 | Unhandled server error |
| 503 | `/api/health` while warming up or DB unreachable |

---

## Health & Monitoring

### `GET /api/health` — no auth

```bash
curl http://localhost:8000/api/health
```
```json
{"status": "ok", "index_ready": true, "database_ok": true, "version": "2.0.0"}
```
`503` with `"status": "starting"` during model warm-up.

### `GET /metrics` — no auth (restrict at network layer)

Prometheus exposition format: `rag_http_requests_total`,
`rag_retrieval_seconds`, `rag_rerank_seconds`, `rag_llm_seconds`,
`rag_semantic_cache_events_total`, `rag_uploads_total`, `rag_active_users`,
`rag_active_conversations`, and standard process metrics.

---

## Auth

Login and signup are rate-limited per client IP (default 10 requests / 60 s
per endpoint; configurable). Exceeding it returns `429` + `Retry-After`.

### `POST /api/auth/signup`

```bash
curl -X POST http://localhost:8000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"full_name": "Ada Lovelace", "email": "ada@corp.com", "password": "Analytical1"}'
```
`201`:
```json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "3q2q8Zl0...",
  "token_type": "bearer",
  "expires_in": 1800,
  "user": {"id": 1, "email": "ada@corp.com", "full_name": "Ada Lovelace",
           "role": "admin", "is_active": true, "created_at": "2026-07-20T10:00:00Z"}
}
```
Password rules: ≥ 8 chars, ≤ 72 bytes, at least one letter and one digit.
**The first account ever created gets `role: "admin"`.** `409` on duplicate
email (case-insensitive).

### `POST /api/auth/login`

```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "ada@corp.com", "password": "Analytical1"}'
```
Same token-pair response. `401` with identical message/timing for unknown
email vs wrong password.

### `POST /api/auth/refresh`

```bash
curl -X POST http://localhost:8000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token": "3q2q8Zl0..."}'
```
New token pair; the presented token is revoked. **Reusing a revoked token
revokes every session for that user** (theft detection) and returns `401`.

### `POST /api/auth/logout`

`{"refresh_token": "...", "everywhere": false}` →
`{"message": "Logged out.", "sessions_revoked": 1}`. Idempotent.

### `GET /api/auth/me` · `PUT /api/auth/me`

GET returns the user object. PUT accepts
`{"full_name"?, "current_password"?, "new_password"?}`; changing the
password requires the current one and revokes all other sessions.

### `GET /api/auth/users` — admin

Array of user objects.

---

## Chat

### `POST /api/chat`

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "Is split tunneling permitted on the corporate VPN?"}'
```
```json
{
  "query": "Is split tunneling permitted on the corporate VPN?",
  "answer": "Split tunneling is disabled on all corporate VPN profiles. [omnicorp_remote_work.md#Secure Connection Requirements, page 1]",
  "citations": ["omnicorp_remote_work.md#Secure Connection Requirements"],
  "retrieved_documents": [
    {"content": "…", "source": "omnicorp_remote_work.md",
     "section": "Secure Connection Requirements", "chunk_id": "omnicorp_remote_work.md_4",
     "page": 1, "vector_rank": 1, "bm25_rank": 2, "score": 0.0325,
     "bm25_score": 8.64, "vector_similarity": 0.61, "vector_distance": 0.64}
  ],
  "reranked_documents": [
    {"content": "…", "rerank_score": 7.12, "confidence": 0.999, "final_rank": 1}
  ],
  "provider": "local",
  "cached": false,
  "metrics": {
    "request_id": "c6ca780d", "cache_hit": false, "retrieval_cache_hit": false,
    "timings_ms": {"embedding": 82, "cache_check": 1, "bm25": 0.2, "vector": 112,
                    "fusion": 0.1, "retrieval": 113, "rerank": 168, "llm": 7576, "total": 7860},
    "retrieved_chunks": 6, "final_chunks": 3,
    "tokens": {"prompt": 812, "completion": 41, "total": 853, "estimated": false}
  },
  "debug": {"request_id": "c6ca780d", "llm_provider": "local",
            "llm_model": "google/flan-t5-base",
            "embedding_model": "sentence-transformers/all-MiniLM-L6-v2",
            "rerank_model": "cross-encoder/ms-marco-MiniLM-L-6-v2",
            "chunk_count": 30, "top_k": 6, "rerank_k": 3}
}
```

**Streaming** — add `"stream": true`; the response is Server-Sent Events,
each `data:` line a JSON object:

```
data: {"type": "metadata", "data": {"retrieved_documents": […], "reranked_documents": […], "provider": "local"}}
data: {"type": "chunk", "content": "Split tunneling is "}
data: {"type": "chunk", "content": "disabled…"}
data: {"type": "done", "data": {"answer": "…", "citations": […], "cached": false, "metrics": {…}, "debug": {…}}}
```

Optional field `"history"`: a plain-text transcript of prior turns that is
appended to the prompt (trimmed to the most recent ~800 chars).

### `GET /api/chat/history?limit=50`

The authenticated user's most recent messages, oldest first:
```json
{"history": [{"role": "user", "content": "…", "timestamp": 1784547933.1}, …]}
```
Sessions are keyed server-side by user id.

---

## Knowledge Library

### `GET /api/library?search=…`

```json
{
  "documents": [
    {"id": 3, "filename": "policy.pdf", "file_type": "pdf", "size_bytes": 48211,
     "status": "completed", "chunk_count": 12, "error_message": null,
     "uploaded_by_id": 1, "uploaded_by_name": "Ada Lovelace",
     "uploaded_at": "2026-07-20T10:30:00Z", "indexed_at": "2026-07-20T10:30:41Z"}
  ],
  "total_documents": 7, "total_chunks": 42, "matched": 1
}
```

### `POST /api/library/upload` — admin

```bash
curl -X POST http://localhost:8000/api/library/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@policy.pdf" -F "files=@handbook.docx"
```
`202`:
```json
{"message": "Accepted 2 file(s) for indexing.", "document_ids": [8, 9], "skipped": []}
```
Accepts `.md .txt .pdf .docx` ≤ 25 MB; rejects (per-file, with reasons in
`skipped`) unsupported types, empties, oversizes, duplicates, and corrupt
files (parse-validated before acceptance). Indexing runs in the background —
new files are embedded incrementally without rebuilding existing indexes.

### `GET /api/library/status?ids=8,9`

```json
{"documents": [{"id": 8, "status": "embedding", …}], "all_done": false}
```
Status progression: `uploaded → chunking → embedding → indexing → completed`
(or `failed` with `error_message`).

### `GET /api/library/{doc_id}/file`

Streams the original file inline (citation "Open Source" button).

### `DELETE /api/library/{doc_id}` — admin

Removes the file, its metadata, and its chunks from the indexes
(incremental delete; full rebuild only as fallback).

---

## Diagnostics & Evaluation

### `GET /api/status`

```json
{"llm_provider": "local", "configured_provider": "local",
 "local_model": "google/flan-t5-base", "embedding_model": "…",
 "rerank_model": "…", "top_k_retrieval": 6, "top_k_rerank": 3,
 "documents_indexed": 30, "status": "operational"}
```

### `GET /api/debug-retrieve?query=…`

Runs the real pipeline once, returns every stage side by side — `bm25`
(Okapi scores), `vector` (L2 distances + similarities), `rrf` (fused with
per-retriever ranks), `reranked` (cross-encoder scores + sigmoid
confidence) — plus `timings_ms` per stage and `retrieval_cache_hit`.

### `POST /api/evaluate` — admin

Runs the evaluation suite over `data/eval_dataset.json`; returns
`mean_retrieval_recall`, `mean_mrr`, `mean_citation_precision`,
`mean_citation_recall`, `mean_semantic_similarity`, `mean_faithfulness`,
`mean_latency`, and per-case results.

### `GET /api/evaluate/history`

Array of past evaluation summaries (up to 50 runs).
