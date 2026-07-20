"""SQLAlchemy ORM model for Knowledge Library document metadata."""

import enum
from datetime import datetime, timezone

from sqlalchemy import String, DateTime, Enum, ForeignKey, Integer, BigInteger
from sqlalchemy.orm import Mapped, mapped_column

from src.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DocumentStatus(str, enum.Enum):
    UPLOADED = "uploaded"    # file saved to disk, awaiting processing
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    INDEXING = "indexing"
    COMPLETED = "completed"
    FAILED = "failed"


class DocumentRecord(Base):
    """
    Metadata row for every file in the Knowledge Library.

    The file's text content lives in the FAISS/BM25 indexes; this table holds
    everything else: provenance, size, processing status, and chunk counts.
    Stored via SQLAlchemy so it runs on SQLite locally and PostgreSQL in
    production (same DATABASE_URL switch as the auth tables).
    """

    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    file_type: Mapped[str] = mapped_column(String(10), nullable=False)  # md / txt / pdf / docx
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    status: Mapped[DocumentStatus] = mapped_column(
        Enum(DocumentStatus, values_callable=lambda e: [m.value for m in e]),
        default=DocumentStatus.UPLOADED,
        nullable=False,
    )
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    uploaded_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    uploaded_by_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
