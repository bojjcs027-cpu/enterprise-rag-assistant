# System Design

## Architecture

```mermaid
graph TB
    subgraph Client
        UI[Dashboard SPA<br/>static/]
    end

    subgraph "FastAPI service"
        MW[Prometheus middleware]
        AUTH[/api/auth/*]
        CHAT[/api/chat]
        LIB[/api/library/*]
        DBG[/api/debug-retrieve]
        EVAL[/api/evaluate]
        HEALTH[/api/health]
        METRICS[/metrics]
    end

    subgraph "RAG pipeline (singletons)"
        CHAIN[RAGChain]
        RET[HybridRetriever<br/>FAISS + BM25 + RRF]
        RER[Cross-encoder reranker]
        SC[SemanticCache]
        LLM[LLM: Claude / Gemini /<br/>OpenAI / local flan-t5]
    end

    subgraph Storage
        SQL[(SQL DB<br/>users, tokens, documents)]
        CHATDB[(chat_history.db)]
        FS[data/ + vectorstore/]
        REDIS[(Redis — optional,<br/>auto-fallback to memory)]
    end

    subgraph Monitoring
        PROM[Prometheus]
        GRAF[Grafana]
    end

    UI --> MW --> AUTH & CHAT & LIB & DBG & EVAL
    CHAT --> CHAIN --> SC & RET --> RER --> LLM
    AUTH --> SQL
    LIB --> SQL & FS & RET
    CHAT --> CHATDB
    RET --> FS
    SC -.-> REDIS
    RET -.-> REDIS
    AUTH -.-> REDIS
    PROM --> METRICS
    GRAF --> PROM
```

## Authentication flow

```mermaid
sequenceDiagram
    participant C as Client
    participant A as /api/auth
    participant DB as SQL DB

    C->>A: POST /signup or /login (rate-limited per IP)
    A->>DB: verify bcrypt hash (timing-equalised)
    A->>DB: store SHA-256(refresh token)
    A-->>C: access JWT (30 min) + refresh token (30 d)

    C->>A: POST /refresh (refresh token)
    A->>DB: hash lookup
    alt token valid & unrevoked
        A->>DB: revoke old, issue new pair (rotation)
        A-->>C: new access + refresh
    else token already revoked (reuse = theft)
        A->>DB: revoke ALL user sessions
        A-->>C: 401
    end
```

First account created becomes admin. `CurrentUser` / `AdminUser` FastAPI
dependencies enforce authentication and RBAC on every protected route.

## Upload & indexing pipeline

```mermaid
flowchart LR
    U[Admin upload] --> V{Validate<br/>ext · size · parse ·<br/>sanitise name · dedupe}
    V -- reject --> SKIP[skipped list]
    V -- accept --> W[Write to data/<br/>+ DB row UPLOADED]
    W --> BG[Background task]
    BG --> INC{Incremental<br/>possible?}
    INC -- yes --> ADD[Chunk new files only<br/>FAISS add_documents<br/>BM25 rebuild in-memory]
    INC -- no --> FULL[Full reindex]
    ADD & FULL --> DONE[COMPLETED + chunk counts<br/>caches invalidated]
    BG -. status: CHUNKING→EMBEDDING→INDEXING .-> UI[Status stepper]
```

Deletes remove only that file's vectors (`FAISS.delete` by docstore id) and
rebuild BM25 from the in-memory chunk list; a full rebuild remains the
fallback for any state the fast path can't handle (placeholder index, last
document, errors).

## Chunking

Markdown → header-aware split (section names preserved for citations) →
recursive split to ~500 chars, 50 overlap. Page numbers estimated at ~2000
chars/page (native pages for PDFs). Each chunk carries
`source`, `section`, `chunk_id` (`filename_N`), `page`.

## Retrieval → rerank → citation

```mermaid
flowchart LR
    Q[Query] --> E[Embed<br/>MiniLM-L6-v2 · LRU]
    E --> SCC{Semantic cache<br/>cos ≥ 0.92}
    SCC -- hit --> ANS[Answer ~1 ms]
    SCC -- miss --> R1[BM25 Okapi] & R2[FAISS L2]
    R1 & R2 --> RRF[RRF fusion k=60 → top 6]
    RRF --> CE[Cross-encoder → top 3]
    CE --> P[Prompt: context blocks prefixed<br/>with citation refs]
    P --> G[LLM: Claude / Gemini / OpenAI /<br/>flan-t5 / extractive fallback]
    G --> CIT[Citation enforcement:<br/>extract or auto-append refs]
    CIT --> ANS2[Answer + citations +<br/>per-stage metrics]
```

Both caches key on the retrieval index generation — any reindex invalidates
them. With `REDIS_URL` set, the retrieval cache gains a shared TTL-bounded L2
and the semantic cache persists to Redis instead of a pickle file.

## Database schema

```mermaid
erDiagram
    users ||--o{ refresh_tokens : has
    users ||--o{ documents : uploaded
    users {
        int id PK
        string email UK
        string full_name
        string hashed_password
        enum role "admin | user"
        bool is_active
        datetime created_at
    }
    refresh_tokens {
        int id PK
        int user_id FK
        string token_hash UK "SHA-256"
        datetime expires_at
        datetime revoked_at "null = active"
    }
    documents {
        int id PK
        string filename UK
        string file_type
        bigint size_bytes
        enum status "uploaded..completed|failed"
        int chunk_count
        string error_message
        int uploaded_by_id FK
        datetime uploaded_at
        datetime indexed_at
    }
    messages {
        int id PK
        string session_id "user:{id} — separate SQLite"
        string role
        string content
        real timestamp
    }
```

`users`/`refresh_tokens`/`documents` live in `DATABASE_URL` (SQLite →
PostgreSQL via env; Alembic migrations). `messages` is a local SQLite file.

## Deployment architecture

```mermaid
graph LR
    LB[Reverse proxy<br/>nginx · TLS] --> APP[RAG container<br/>uvicorn :8000]
    APP --> VOL[(rag_data volume<br/>docs · indexes · DBs)]
    APP -.-> PG[(PostgreSQL)]
    APP -.-> RD[(Redis)]
    PROM[Prometheus] --> APP
    GRAF[Grafana :3001] --> PROM
    HC[Orchestrator healthcheck] --> APP
```

Solid lines are the minimal single-node deploy (`docker compose up`);
dashed components are opt-in via env (`DATABASE_URL`, `REDIS_URL`) and the
monitoring overlay (`docker-compose.grafana.yml`). See
[DEPLOYMENT.md](DEPLOYMENT.md).
