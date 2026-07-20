"""
Unit tests for the Enterprise Knowledge Library.

Heavy pieces (embedding/reindex) are mocked; everything else — validation,
metadata persistence, search, RBAC, status polling — runs for real against an
in-memory SQLite database.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.auth.dependencies import get_current_user
from src.auth.models import User, UserRole
from src.db import Base, get_db
from src.documents import service as service_module
from src.documents.models import DocumentRecord, DocumentStatus
from src.documents.repository import DocumentRepository
from src.documents.router import router as library_router
from src.documents.service import sanitize_filename


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    engine.dispose()


@pytest.fixture()
def admin_user():
    return User(id=1, email="admin@example.com", full_name="Admin",
                hashed_password="x", role=UserRole.ADMIN, is_active=True)


@pytest.fixture()
def regular_user():
    return User(id=2, email="user@example.com", full_name="User",
                hashed_password="x", role=UserRole.USER, is_active=True)


@pytest.fixture()
def patched_service(session_factory, tmp_path, monkeypatch):
    """Points the library service at the test DB and a temp data dir, and
    replaces the reindex step with a stage-simulating stub."""
    monkeypatch.setattr(service_module, "SessionLocal", session_factory)
    monkeypatch.setattr(service_module.config, "DATA_DIR", tmp_path)

    class FakeRetriever:
        all_documents = []
        # When None, incremental ops report "not applicable" and the service
        # falls back to the full reindex stub (the behaviour most tests
        # exercise). Tests can set it to True to simulate the fast path.
        incremental_result = None
        incremental_calls = []

        def initialize(self, force_reindex=False):
            pass

        def reindex(self, progress_callback=None):
            for stage in ("chunking", "embedding", "indexing"):
                if progress_callback:
                    progress_callback(stage)

        def add_files_incremental(self, filenames, progress_callback=None):
            self.incremental_calls.append(("add", list(filenames)))
            if self.incremental_result:
                for stage in ("chunking", "embedding", "indexing"):
                    if progress_callback:
                        progress_callback(stage)
                return True
            return False

        def remove_file_incremental(self, filename):
            self.incremental_calls.append(("remove", filename))
            return bool(self.incremental_result)

    fake = FakeRetriever()
    monkeypatch.setattr(service_module.retriever, "retriever_instance", fake)
    return fake


def make_client(session_factory, user):
    app = FastAPI()
    app.include_router(library_router)

    def override_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


# ---------------------------------------------------------------------------
# Filename sanitisation
# ---------------------------------------------------------------------------

class TestSanitizeFilename:
    def test_strips_path_traversal(self):
        assert sanitize_filename("../../etc/passwd") == "passwd"
        assert sanitize_filename("..\\..\\windows\\evil.txt") == "evil.txt"

    def test_neutralises_special_chars(self):
        assert sanitize_filename("a<b>|c?.txt") == "a_b__c_.txt"

    def test_keeps_normal_names(self):
        assert sanitize_filename("Policy Doc_v2-final.pdf") == "Policy Doc_v2-final.pdf"


# ---------------------------------------------------------------------------
# Service: save_uploads validation
# ---------------------------------------------------------------------------

class TestSaveUploads:
    def test_valid_file_saved_and_recorded(self, patched_service, session_factory,
                                           tmp_path, admin_user):
        ids, skipped = service_module.library_service.save_uploads(
            [("notes.txt", b"hello world")], admin_user
        )
        assert len(ids) == 1 and skipped == []
        assert (tmp_path / "notes.txt").read_bytes() == b"hello world"

        with session_factory() as db:
            rec = DocumentRepository(db).get(ids[0])
            assert rec.status == DocumentStatus.UPLOADED
            assert rec.file_type == "txt"
            assert rec.size_bytes == 11
            assert rec.uploaded_by_name == "Admin"

    def test_unsupported_type_skipped(self, patched_service, admin_user):
        ids, skipped = service_module.library_service.save_uploads(
            [("virus.exe", b"MZ")], admin_user
        )
        assert ids == [] and "unsupported type" in skipped[0]

    def test_empty_file_skipped(self, patched_service, admin_user):
        ids, skipped = service_module.library_service.save_uploads(
            [("empty.txt", b"")], admin_user
        )
        assert ids == [] and "empty file" in skipped[0]

    def test_duplicate_skipped(self, patched_service, admin_user):
        svc = service_module.library_service
        svc.save_uploads([("dup.txt", b"one")], admin_user)
        ids, skipped = svc.save_uploads([("dup.txt", b"two")], admin_user)
        assert ids == [] and "already in library" in skipped[0]

    def test_oversized_file_skipped(self, patched_service, admin_user, monkeypatch):
        monkeypatch.setattr(service_module, "MAX_FILE_SIZE_BYTES", 10)
        ids, skipped = service_module.library_service.save_uploads(
            [("big.txt", b"x" * 11)], admin_user
        )
        assert ids == [] and "exceeds" in skipped[0]

    def test_corrupt_pdf_rejected_at_upload(self, patched_service, admin_user, tmp_path):
        """A file the indexer cannot parse must be rejected up front — a global
        reindex would otherwise fail the whole batch and poison future runs."""
        ids, skipped = service_module.library_service.save_uploads(
            [("broken.pdf", b"%PDF-1.4 this is not a real pdf")], admin_user
        )
        assert ids == []
        assert "corrupt or unreadable" in skipped[0]
        assert not (tmp_path / "broken.pdf").exists()  # never written to disk

    def test_corrupt_docx_rejected_at_upload(self, patched_service, admin_user):
        ids, skipped = service_module.library_service.save_uploads(
            [("broken.docx", b"not a zip archive")], admin_user
        )
        assert ids == [] and "corrupt or unreadable" in skipped[0]

    def test_non_utf8_txt_rejected(self, patched_service, admin_user):
        ids, skipped = service_module.library_service.save_uploads(
            [("binary.txt", b"\xff\xfe\x00\x01binary junk")], admin_user
        )
        assert ids == [] and "corrupt or unreadable" in skipped[0]


# ---------------------------------------------------------------------------
# Service: staged processing
# ---------------------------------------------------------------------------

class TestProcessBatch:
    def test_batch_reaches_completed_with_chunk_counts(
            self, patched_service, session_factory, admin_user):
        svc = service_module.library_service
        ids, _ = svc.save_uploads([("a.txt", b"alpha")], admin_user)

        class FakeDoc:
            metadata = {"source": "a.txt"}
        patched_service.all_documents = [FakeDoc(), FakeDoc(), FakeDoc()]

        svc.process_batch(ids)

        with session_factory() as db:
            rec = DocumentRepository(db).get(ids[0])
            assert rec.status == DocumentStatus.COMPLETED
            assert rec.chunk_count == 3
            assert rec.indexed_at is not None

    def test_failed_reindex_marks_failed(self, patched_service, session_factory,
                                         admin_user, monkeypatch):
        svc = service_module.library_service
        ids, _ = svc.save_uploads([("b.txt", b"beta")], admin_user)

        def boom(progress_callback=None):
            raise RuntimeError("index exploded")
        monkeypatch.setattr(patched_service, "reindex", boom)

        svc.process_batch(ids)

        with session_factory() as db:
            rec = DocumentRepository(db).get(ids[0])
            assert rec.status == DocumentStatus.FAILED
            assert "index exploded" in rec.error_message

    def test_incremental_path_skips_full_reindex(
            self, patched_service, session_factory, admin_user, monkeypatch):
        svc = service_module.library_service
        ids, _ = svc.save_uploads([("c.txt", b"gamma")], admin_user)

        patched_service.incremental_result = True
        patched_service.incremental_calls = []

        def full_reindex_forbidden(progress_callback=None):
            raise AssertionError("full reindex must not run when incremental succeeds")
        monkeypatch.setattr(patched_service, "reindex", full_reindex_forbidden)

        svc.process_batch(ids)

        assert ("add", ["c.txt"]) in patched_service.incremental_calls
        with session_factory() as db:
            rec = DocumentRepository(db).get(ids[0])
            assert rec.status == DocumentStatus.COMPLETED


# ---------------------------------------------------------------------------
# Repository search & totals
# ---------------------------------------------------------------------------

class TestRepository:
    def _seed(self, session_factory):
        with session_factory() as db:
            repo = DocumentRepository(db)
            repo.add(DocumentRecord(filename="aws_security.md", file_type="md",
                                    size_bytes=10, status=DocumentStatus.COMPLETED,
                                    chunk_count=5, uploaded_by_name="Alice"))
            repo.add(DocumentRecord(filename="hr_handbook.pdf", file_type="pdf",
                                    size_bytes=20, status=DocumentStatus.COMPLETED,
                                    chunk_count=7, uploaded_by_name="Bob"))

    def test_search_matches_filename_case_insensitive(self, session_factory):
        self._seed(session_factory)
        with session_factory() as db:
            repo = DocumentRepository(db)
            assert len(repo.list_all(search="AWS")) == 1
            assert len(repo.list_all(search="handbook")) == 1
            assert len(repo.list_all(search="zzz")) == 0
            assert len(repo.list_all()) == 2

    def test_search_matches_uploader(self, session_factory):
        self._seed(session_factory)
        with session_factory() as db:
            assert DocumentRepository(db).list_all(search="alice")[0].filename == "aws_security.md"

    def test_totals(self, session_factory):
        self._seed(session_factory)
        with session_factory() as db:
            assert DocumentRepository(db).totals() == (2, 12)


# ---------------------------------------------------------------------------
# Router: RBAC + endpoints
# ---------------------------------------------------------------------------

class TestRouter:
    def test_list_requires_auth_returns_counters(self, session_factory, regular_user,
                                                 patched_service, admin_user):
        service_module.library_service.save_uploads([("c.txt", b"gamma")], admin_user)
        client = make_client(session_factory, regular_user)
        res = client.get("/api/library")
        assert res.status_code == 200
        body = res.json()
        assert body["total_documents"] == 1
        assert body["matched"] == 1

    def test_search_param_filters(self, session_factory, regular_user,
                                  patched_service, admin_user):
        svc = service_module.library_service
        svc.save_uploads([("alpha.txt", b"a"), ("beta.txt", b"b")], admin_user)
        client = make_client(session_factory, regular_user)
        body = client.get("/api/library?search=alpha").json()
        assert body["matched"] == 1
        assert body["total_documents"] == 2  # counters stay library-wide

    def test_upload_forbidden_for_regular_user(self, session_factory, regular_user):
        client = make_client(session_factory, regular_user)
        res = client.post("/api/library/upload",
                          files=[("files", ("x.txt", b"data", "text/plain"))])
        assert res.status_code == 403

    def test_upload_accepted_for_admin(self, session_factory, admin_user,
                                       patched_service):
        client = make_client(session_factory, admin_user)
        res = client.post("/api/library/upload",
                          files=[("files", ("ok.txt", b"data", "text/plain"))])
        assert res.status_code == 202
        body = res.json()
        assert len(body["document_ids"]) == 1
        # Background task ran during TestClient response cycle → completed
        status = client.get(f"/api/library/status?ids={body['document_ids'][0]}").json()
        assert status["all_done"] is True

    def test_upload_all_rejected_returns_400(self, session_factory, admin_user,
                                             patched_service):
        client = make_client(session_factory, admin_user)
        res = client.post("/api/library/upload",
                          files=[("files", ("bad.exe", b"MZ", "application/octet-stream"))])
        assert res.status_code == 400

    def test_status_validates_ids(self, session_factory, regular_user):
        client = make_client(session_factory, regular_user)
        assert client.get("/api/library/status?ids=abc").status_code == 422

    def test_delete_forbidden_for_regular_user(self, session_factory, regular_user):
        client = make_client(session_factory, regular_user)
        assert client.delete("/api/library/1").status_code == 403

    def test_delete_unknown_returns_404(self, session_factory, admin_user,
                                        patched_service):
        client = make_client(session_factory, admin_user)
        assert client.delete("/api/library/999").status_code == 404

    def test_delete_removes_file_and_record(self, session_factory, admin_user,
                                            patched_service, tmp_path):
        svc = service_module.library_service
        ids, _ = svc.save_uploads([("gone.txt", b"bye")], admin_user)
        assert (tmp_path / "gone.txt").exists()

        client = make_client(session_factory, admin_user)
        res = client.delete(f"/api/library/{ids[0]}")
        assert res.status_code == 200
        assert not (tmp_path / "gone.txt").exists()
        assert client.get("/api/library").json()["total_documents"] == 0
