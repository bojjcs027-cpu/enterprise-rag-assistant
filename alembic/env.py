"""Alembic environment — wired to the application's models and DATABASE_URL."""

import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool

from alembic import context

# Make the project root importable so `src` resolves when alembic is run
# from anywhere.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import config as app_config  # noqa: E402
from src.db import Base  # noqa: E402
from src.auth import models  # noqa: E402,F401 — registers User/RefreshToken on Base
from src.documents import models as document_models  # noqa: E402,F401 — registers DocumentRecord on Base

config = context.config

# The URL always comes from the environment (.env), never from alembic.ini,
# so SQLite locally and PostgreSQL in production use the same migrations.
config.set_main_option("sqlalchemy.url", app_config.DATABASE_URL)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emits SQL without a DB connection)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (against the live database)."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
