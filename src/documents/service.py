"""
Business logic for the Enterprise Knowledge Library.

Upload flow (per batch):
  1. UPLOADED  — files validated and written to data/, metadata rows created
  2. CHUNKING  — document_loader splits every library file into chunks
  3. EMBEDDING — FAISS vector store rebuilt (sentence-transformers)
  4. INDEXING  — vectors + BM25 index persisted to disk
  5. COMPLETED — per-file chunk counts recorded, indexed_at stamped

Stages 2-4 are reported by the retriever's additive progress callback; the
frontend polls /api/library/status to animate the stepper. A module-level
lock serialises reindex runs so concurrent uploads/deletes cannot corrupt
the indexes.
"""

import logging
import re
import threading
from pathlib import Path

from src import config, retriever
from src.auth.models import User
from src.db import SessionLocal
from src.documents.models import DocumentRecord, DocumentStatus
from src.documents.repository import DocumentRepository

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".md", ".txt", ".pdf", ".docx"}
MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024  # 25 MB per file

_reindex_lock = threading.Lock()


class LibraryError(Exception):
    status_code = 400

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class DocumentNotFound(LibraryError):
    status_code = 404


def sanitize_filename(name: str) -> str:
    """Strips directories and neutralises anything outside a safe charset."""
    name = Path(name).name  # drop any path components
    name = re.sub(r"[^A-Za-z0-9._\- ]", "_", name).strip()
    return name[:255]


def validate_content(ext: str, content: bytes) -> str | None:
    """
    Parses the file the same way the indexer will, BEFORE accepting it.
    Returns an error string for corrupt/invalid files, else None.

    Critical because indexing is a global rebuild: one unreadable file would
    otherwise fail the whole batch and poison every future reindex until it
    was manually removed from data/.
    """
    import io
    try:
        if ext == ".pdf":
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(content))
            if len(reader.pages) == 0:
                return "PDF contains no pages"
        elif ext == ".docx":
            import zipfile
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                if "word/document.xml" not in zf.namelist():
                    return "not a valid DOCX archive"
        elif ext in (".txt", ".md"):
            content.decode("utf-8")
    except Exception as exc:
        return f"corrupt or unreadable {ext.lstrip('.')} file ({type(exc).__name__})"
    return None


def _chunk_counts_by_source() -> dict[str, int]:
    counts: dict[str, int] = {}
    for d in retriever.retriever_instance.all_documents:
        src = d.metadata.get("source")
        if src:
            counts[src] = counts.get(src, 0) + 1
    return counts


class LibraryService:
    """Stateless facade — every method opens its own short-lived DB session,
    so it is safe to call from background threads."""

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------

    def save_uploads(self, files: list[tuple[str, bytes]], uploader: User
                     ) -> tuple[list[int], list[str]]:
        """
        Validates and writes uploaded files to data/, creating an UPLOADED
        metadata row for each. Returns (created_ids, skipped_filenames).
        Files list is (original_filename, content_bytes).
        """
        created_ids: list[int] = []
        skipped: list[str] = []

        with SessionLocal() as db:
            repo = DocumentRepository(db)
            for original_name, content in files:
                name = sanitize_filename(original_name)
                ext = Path(name).suffix.lower()

                if ext not in ALLOWED_EXTENSIONS:
                    skipped.append(f"{original_name} (unsupported type)")
                    continue
                if not content:
                    skipped.append(f"{original_name} (empty file)")
                    continue
                if len(content) > MAX_FILE_SIZE_BYTES:
                    skipped.append(f"{original_name} (exceeds 25 MB limit)")
                    continue
                if repo.get_by_filename(name):
                    skipped.append(f"{original_name} (already in library)")
                    continue
                error = validate_content(ext, content)
                if error:
                    skipped.append(f"{original_name} ({error})")
                    continue

                target = config.DATA_DIR / name
                with open(target, "wb") as fh:
                    fh.write(content)

                record = repo.add(DocumentRecord(
                    filename=name,
                    file_type=ext.lstrip("."),
                    size_bytes=len(content),
                    status=DocumentStatus.UPLOADED,
                    uploaded_by_id=uploader.id,
                    uploaded_by_name=uploader.full_name,
                ))
                created_ids.append(record.id)
                logger.info("[Library] Saved upload %s (%d bytes) by %s",
                            name, len(content), uploader.email)

        return created_ids, skipped

    # ------------------------------------------------------------------
    # Background processing (chunk → embed → index)
    # ------------------------------------------------------------------

    def process_batch(self, ids: list[int]) -> None:
        """Rebuilds the RAG indexes, advancing the batch's status at each
        stage. Runs in a background thread after the upload response."""
        stage_map = {
            "chunking":  DocumentStatus.CHUNKING,
            "embedding": DocumentStatus.EMBEDDING,
            "indexing":  DocumentStatus.INDEXING,
        }

        def on_stage(stage: str):
            status = stage_map.get(stage)
            if status:
                with SessionLocal() as db:
                    DocumentRepository(db).set_status(ids, status)
                logger.info("[Library] Batch %s -> %s", ids, stage)

        try:
            with _reindex_lock:
                retriever.retriever_instance.initialize()
                retriever.retriever_instance.reindex(progress_callback=on_stage)
            self._finalise_completed(ids)
            logger.info("[Library] Batch %s completed", ids)
        except Exception as exc:
            logger.exception("[Library] Indexing failed for batch %s", ids)
            with SessionLocal() as db:
                DocumentRepository(db).set_status(
                    ids, DocumentStatus.FAILED, error=str(exc)[:500]
                )

    def _finalise_completed(self, ids: list[int]) -> None:
        counts = _chunk_counts_by_source()
        with SessionLocal() as db:
            repo = DocumentRepository(db)
            for record in repo.get_many(ids):
                repo.set_chunk_count(record.id, counts.get(record.filename, 0))
            repo.set_status(ids, DocumentStatus.COMPLETED)
            # Reindexing recounts every document's chunks, so refresh the rest too.
            for record in repo.list_all():
                if record.id not in ids:
                    new_count = counts.get(record.filename, 0)
                    if new_count != record.chunk_count:
                        repo.set_chunk_count(record.id, new_count)

    # ------------------------------------------------------------------
    # Delete
    # ------------------------------------------------------------------

    def delete_document(self, doc_id: int) -> str:
        """Removes the file and its metadata, then rebuilds the indexes.
        Returns the deleted filename."""
        with SessionLocal() as db:
            repo = DocumentRepository(db)
            record = repo.get(doc_id)
            if record is None:
                raise DocumentNotFound("Document not found.")
            filename = record.filename
            repo.delete(record)

        target = config.DATA_DIR / filename
        if target.exists():
            target.unlink()

        with _reindex_lock:
            retriever.retriever_instance.initialize()
            retriever.retriever_instance.reindex()

        # Chunk counts shift after a rebuild — refresh all remaining rows.
        counts = _chunk_counts_by_source()
        with SessionLocal() as db:
            repo = DocumentRepository(db)
            for record in repo.list_all():
                if record.chunk_count != counts.get(record.filename, 0):
                    repo.set_chunk_count(record.id, counts.get(record.filename, 0))

        logger.info("[Library] Deleted %s and rebuilt indexes", filename)
        return filename

    # ------------------------------------------------------------------
    # Startup sync
    # ------------------------------------------------------------------

    def sync_filesystem(self) -> None:
        """
        Reconciles DB metadata with the data/ directory on startup:
        - files on disk without a row get a COMPLETED row (legacy/seed docs)
        - rows whose file vanished are removed
        - chunk counts are refreshed from the live index
        """
        counts = _chunk_counts_by_source()
        on_disk = {
            p.name: p for ext in ALLOWED_EXTENSIONS
            for p in config.DATA_DIR.glob(f"*{ext}")
        }

        with SessionLocal() as db:
            repo = DocumentRepository(db)
            existing = {r.filename: r for r in repo.list_all()}

            for name, path in on_disk.items():
                if name not in existing:
                    repo.add(DocumentRecord(
                        filename=name,
                        file_type=path.suffix.lstrip(".").lower(),
                        size_bytes=path.stat().st_size,
                        status=DocumentStatus.COMPLETED,
                        chunk_count=counts.get(name, 0),
                        uploaded_by_name="System (pre-existing)",
                    ))
                    logger.info("[Library] Registered pre-existing file %s", name)

            for name, record in existing.items():
                if name not in on_disk:
                    repo.delete(record)
                    logger.info("[Library] Removed stale record for %s", name)
                elif record.status == DocumentStatus.COMPLETED and \
                        record.chunk_count != counts.get(name, 0):
                    repo.set_chunk_count(record.id, counts.get(name, 0))


library_service = LibraryService()
