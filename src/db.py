"""
SQLAlchemy database setup.

The connection string comes from the DATABASE_URL environment variable, so the
same code runs on SQLite locally and PostgreSQL in production — switching is a
one-line .env change (e.g. postgresql+psycopg2://user:pass@host:5432/dbname).
Schema changes are managed with Alembic (see alembic/ at the repo root).
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from src import config


class Base(DeclarativeBase):
    """Declarative base shared by all ORM models."""


def _create_engine():
    kwargs = {"pool_pre_ping": True}
    if config.DATABASE_URL.startswith("sqlite"):
        # SQLite objects are bound to the creating thread by default; FastAPI
        # serves requests from a threadpool, so this must be disabled.
        kwargs["connect_args"] = {"check_same_thread": False}
    return create_engine(config.DATABASE_URL, **kwargs)


engine = _create_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db():
    """FastAPI dependency yielding a request-scoped database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
