"""Data-access layer for Knowledge Library document metadata."""

from datetime import datetime, timezone

from sqlalchemy import select, func, update
from sqlalchemy.orm import Session

from src.documents.models import DocumentRecord, DocumentStatus


class DocumentRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self, doc_id: int) -> DocumentRecord | None:
        return self.db.get(DocumentRecord, doc_id)

    def get_by_filename(self, filename: str) -> DocumentRecord | None:
        return self.db.scalar(
            select(DocumentRecord).where(DocumentRecord.filename == filename)
        )

    def get_many(self, ids: list[int]) -> list[DocumentRecord]:
        if not ids:
            return []
        return list(self.db.scalars(
            select(DocumentRecord).where(DocumentRecord.id.in_(ids))
        ))

    def list_all(self, search: str | None = None) -> list[DocumentRecord]:
        stmt = select(DocumentRecord).order_by(DocumentRecord.uploaded_at.desc())
        if search:
            # Case-insensitive substring match on filename and uploader.
            pattern = f"%{search.lower()}%"
            stmt = stmt.where(
                func.lower(DocumentRecord.filename).like(pattern)
                | func.lower(func.coalesce(DocumentRecord.uploaded_by_name, "")).like(pattern)
            )
        return list(self.db.scalars(stmt))

    def totals(self) -> tuple[int, int]:
        """Returns (total_documents, total_chunks) across the whole library."""
        row = self.db.execute(
            select(func.count(DocumentRecord.id),
                   func.coalesce(func.sum(DocumentRecord.chunk_count), 0))
        ).one()
        return int(row[0]), int(row[1])

    def add(self, record: DocumentRecord) -> DocumentRecord:
        self.db.add(record)
        self.db.commit()
        self.db.refresh(record)
        return record

    def delete(self, record: DocumentRecord) -> None:
        self.db.delete(record)
        self.db.commit()

    def set_status(self, ids: list[int], status: DocumentStatus,
                   error: str | None = None) -> None:
        if not ids:
            return
        values = {"status": status, "error_message": error}
        if status == DocumentStatus.COMPLETED:
            values["indexed_at"] = datetime.now(timezone.utc)
        self.db.execute(
            update(DocumentRecord).where(DocumentRecord.id.in_(ids)).values(**values)
        )
        self.db.commit()

    def set_chunk_count(self, doc_id: int, count: int) -> None:
        self.db.execute(
            update(DocumentRecord).where(DocumentRecord.id == doc_id)
            .values(chunk_count=count)
        )
        self.db.commit()
