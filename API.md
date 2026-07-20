# API Reference

Base URL: `http://HOST:PORT` (default `http://127.0.0.1:8000`).
Interactive documentation: `/docs` (Swagger UI), `/redoc`.

Authentication: `Authorization: Bearer <access_token>` unless noted.
Errors are JSON: `{"detail": "message"}` with a conventional status code.

## Health

### `GET /api/health` — no auth
Liveness/readiness probe. `200` when serving, `503` while warming up or if
the database is unreachable.

```json
{"status": "ok", "index_ready": true, "database_ok": true, "version": "2.0.0"}
```

## Auth

Login and signup are rate-limited per client IP (default 10/60 s; `429` +
`Retry-After` when exceeded).

### `POST /api/auth/signup` — no auth
`{"full_name", "email", "password"}` → `201` with a token pair. Password:
≥ 8 chars, ≤ 72 bytes, at least one letter and one digit. **The first
account created becomes the administrator.** `409` on duplicate email.

### `POST /api/auth/login` — no auth
`{"email", "password", "remember"?}` → token pair. `401` on bad
credentials (identical error/timing for unknown email vs wrong password).

Token pair shape:
```json
{
  "access_token": "…", "refresh_token": "…", "token_type": "bearer",
  "expires_in": 1800,
  "user": {"id": 1, "email": "…", "full_name": "…", "role": "admin", "is_active": true, "created_at": "…"}
}
```

### `POST /api/auth/refresh` — no auth
`{"refresh_token"}` → new token pair. The presented token is revoked
(rotation). Reusing a revoked token revokes **all** the user's sessions.

### `POST /api/auth/logout` — no auth
`{"refresh_token", "everywhere"?}` → revokes that session (or all).
Idempotent.

### `GET /api/auth/me` · `PUT /api/auth/me`
Profile fetch / update. Update accepts `{"full_name"?, "current_password"?,
"new_password"?}`; a password change revokes all other sessions.

### `GET /api/auth/users` — admin
Lists all users.

## Chat

### `POST /api/chat`
```json
{"query": "…", "stream": false, "history": ""}
```
Non-streaming → full response:
```json
{
  "query": "…", "answer": "… [file.md#Section, page 1]",
  "citations": ["file.md#Section"],
  "retrieved_documents": [{"content", "source", "section", "chunk_id", "page",
    "vector_rank", "bm25_rank", "score", "bm25_score", "vector_similarity", "vector_distance"}],
  "reranked_documents": [{…, "rerank_score", "confidence", "final_rank"}],
  "provider": "local", "cached": false,
  "metrics": {"request_id", "cache_hit", "retrieval_cache_hit",
    "timings_ms": {"embedding", "cache_check", "bm25", "vector", "fusion",
      "retrieval", "rerank", "llm", "total"},
    "retrieved_chunks", "final_chunks",
    "tokens": {"prompt", "completion", "total", "estimated"}},
  "debug": {"request_id", "llm_provider", "llm_model", "embedding_model",
    "rerank_model", "chunk_count", "top_k", "rerank_k"}
}
```
With `"stream": true` → Server-Sent Events; each `data:` line is JSON:
`{"type": "metadata", …}` (documents + provider, sent first),
`{"type": "chunk", "content": "…"}` (answer tokens),
`{"type": "done", "data": {answer, citations, cached, metrics, debug}}`.

### `GET /api/chat/history?limit=50`
The authenticated user's most recent messages, oldest first. Sessions are
keyed server-side by user id — clients cannot read other users' history.

## Knowledge Library

### `GET /api/library?search=…`
Document list with metadata (status, chunk counts, uploader, timestamps)
plus `total_documents` / `total_chunks`. `search` filters by filename or
uploader, case-insensitive.

### `POST /api/library/upload` — admin
`multipart/form-data`, field `files` (repeatable). Accepts `.md .txt .pdf
.docx` ≤ 25 MB each; rejects duplicates, empty, oversized, or corrupt
files (parse-validated before acceptance). Returns `202` with
`document_ids` and per-file `skipped` reasons; indexing proceeds in the
background.

### `GET /api/library/status?ids=1,2,3`
Processing status for a batch: per-document
`uploaded|chunking|embedding|indexing|completed|failed` + `all_done`.

### `GET /api/library/{doc_id}/file`
Streams the original source file (inline disposition).

### `DELETE /api/library/{doc_id}` — admin
Removes the file + metadata and rebuilds the indexes.

## Diagnostics & Evaluation

### `GET /api/status`
Active provider/models, k-values, and indexed chunk count.

### `GET /api/debug-retrieve?query=…`
Runs the real pipeline once and returns every stage side by side: `bm25`
(Okapi scores), `vector` (L2 distances + similarities), `rrf` (fused), and
`reranked` (cross-encoder scores + confidence), plus per-stage `timings_ms`
and `retrieval_cache_hit`.

### `POST /api/evaluate` — admin
Runs the evaluation suite; returns summary metrics + per-case results.

### `GET /api/evaluate/history`
Past evaluation runs (up to 50).
