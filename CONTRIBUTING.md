# Contributing

## Setup

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env    # set JWT_SECRET_KEY at minimum
python run.py --server
```

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md). Rules of thumb:

- HTTP handlers stay thin: routers translate exceptions, services own the
  logic, repositories own the queries (see `src/auth/` and
  `src/documents/` for the pattern).
- Model singletons (`retriever_instance`, `reranker_instance`,
  `rag_chain_instance`) are process-wide; database sessions are
  request-scoped via `Depends(get_db)`.
- Config comes from `src/config.py` (env-driven) — never hardcode
  secrets, hosts, or model names elsewhere.

## Tests

```bash
pytest tests/           # full suite
pytest tests/test_auth.py -k refresh   # focused
```

- Tests must not touch real data: use in-memory SQLite (see fixtures in
  `tests/test_auth.py` / `tests/test_library.py`) and `tmp_path`.
- `tests/conftest.py` pre-imports torch (Windows DLL workaround) and resets
  the auth rate limiter between tests — keep both if you refactor it.
- New endpoints and bug fixes ship with tests. Regressions found in review
  get a test that fails without the fix.

## Database changes

Schema is managed with Alembic:

```bash
alembic revision --autogenerate -m "add my_table"
alembic upgrade head
```

Import new model modules in `alembic/env.py` and `src/app.py` so they
register on `Base`.

## Quality gates

CI (`.github/workflows/ci.yml`) runs the unit suite and then the RAG
evaluation gate (`python -m src.run_ci`): retrieval recall ≥ 0.80, citation
precision ≥ 0.80, semantic similarity ≥ 0.70 over `data/eval_dataset.json`.
If you change chunking, retrieval, prompts, or the eval set, run the gate
locally before pushing.

## Style

- Python: type hints on public functions, docstrings explaining *why* when
  behaviour is non-obvious, `logging` (never `print`) in request paths.
- Frontend: vanilla JS, no build step; all user/document-derived strings go
  through `escapeHTML()` before any `innerHTML` assignment.
- Commits: imperative subject, body explains motivation; one logical change
  per commit.
