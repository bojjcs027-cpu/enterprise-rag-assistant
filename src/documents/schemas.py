"""Pydantic schemas for the Knowledge Library API."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class DocumentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    filename: str
    file_type: str
    size_bytes: int
    status: str
    chunk_count: int
    error_message: str | None = None
    uploaded_by_name: str | None = None
    uploaded_at: datetime
    indexed_at: datetime | None = None


class LibraryResponse(BaseModel):
    documents: list[DocumentResponse]
    total_documents: int      # all documents in the library (unfiltered)
    total_chunks: int         # sum of chunk counts (unfiltered)
    matched: int              # documents matching the current search filter


class UploadAccepted(BaseModel):
    message: str
    document_ids: list[int]
    skipped: list[str]        # filenames rejected (unsupported type / duplicates)


class StatusResponse(BaseModel):
    documents: list[DocumentResponse]
    all_done: bool
