"""HTTP layer for the Enterprise Knowledge Library."""

import logging
from typing import Annotated, List

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from src.auth.dependencies import AdminUser, CurrentUser
from src.db import get_db
from src.documents.models import DocumentStatus
from src.documents.repository import DocumentRepository
from src.documents.schemas import (
    DocumentResponse,
    LibraryResponse,
    StatusResponse,
    UploadAccepted,
)
from src.documents.service import LibraryError, library_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/library", tags=["library"])

_TERMINAL = {DocumentStatus.COMPLETED, DocumentStatus.FAILED}


@router.get("", response_model=LibraryResponse)
def list_library(
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    search: str | None = Query(default=None, max_length=100),
):
    """Lists library documents with metadata. `search` filters by filename
    or uploader (case-insensitive substring)."""
    repo = DocumentRepository(db)
    docs = repo.list_all(search=search)
    total_docs, total_chunks = repo.totals()
    return LibraryResponse(
        documents=[DocumentResponse.model_validate(d) for d in docs],
        total_documents=total_docs,
        total_chunks=total_chunks,
        matched=len(docs),
    )


@router.post("/upload", response_model=UploadAccepted, status_code=202)
async def upload_documents(
    admin: AdminUser,
    background: BackgroundTasks,
    files: List[UploadFile] = File(...),
):
    """
    Accepts one or more files (.md/.txt/.pdf/.docx, ≤25 MB each), stores them,
    and starts chunk→embed→index processing in the background. Returns 202
    with the created document ids; poll /api/library/status to follow the
    stage progression.
    """
    payload: list[tuple[str, bytes]] = []
    for f in files:
        content = await f.read()
        payload.append((f.filename or "unnamed", content))

    try:
        created_ids, skipped = library_service.save_uploads(payload, admin)
    except LibraryError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    if created_ids:
        from src import metrics
        metrics.UPLOADS.inc(len(created_ids))
        background.add_task(library_service.process_batch, created_ids)

    if not created_ids and skipped:
        raise HTTPException(
            status_code=400,
            detail="No files accepted: " + "; ".join(skipped),
        )

    return UploadAccepted(
        message=f"Accepted {len(created_ids)} file(s) for indexing.",
        document_ids=created_ids,
        skipped=skipped,
    )


@router.get("/status", response_model=StatusResponse)
def batch_status(
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    ids: str = Query(..., description="Comma-separated document ids"),
):
    """Processing status for an upload batch — polled by the UI stepper."""
    try:
        id_list = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=422, detail="ids must be comma-separated integers.")

    docs = DocumentRepository(db).get_many(id_list)
    return StatusResponse(
        documents=[DocumentResponse.model_validate(d) for d in docs],
        all_done=all(d.status in _TERMINAL for d in docs) if docs else True,
    )


_MEDIA_TYPES = {
    "md":   "text/markdown; charset=utf-8",
    "txt":  "text/plain; charset=utf-8",
    "pdf":  "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


@router.get("/{doc_id}/file")
def get_document_file(
    doc_id: int,
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
):
    """Serves the original source document (citation 'Open Source' button).
    The path comes from the DB record — already sanitised at upload."""
    from fastapi.responses import FileResponse
    from src import config

    record = DocumentRepository(db).get(doc_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    path = config.DATA_DIR / record.filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File missing from disk.")
    return FileResponse(
        path,
        media_type=_MEDIA_TYPES.get(record.file_type, "application/octet-stream"),
        filename=record.filename,
        content_disposition_type="inline",
    )


@router.delete("/{doc_id}")
def delete_document(doc_id: int, admin: AdminUser):
    """Admin-only: removes a document and rebuilds the RAG indexes."""
    try:
        filename = library_service.delete_document(doc_id)
    except LibraryError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    return {"message": f"Deleted {filename} and rebuilt indexes."}
