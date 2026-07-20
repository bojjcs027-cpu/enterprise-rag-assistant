"""
Unit tests for the authentication system.

Runs against an isolated in-memory SQLite database via dependency override —
no models, no network, and no interference with the real data/auth.db.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src import config
from src.auth import security
from src.auth.models import User, UserRole
from src.auth.router import router as auth_router
from src.db import Base, get_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def jwt_test_secret(monkeypatch):
    """Ensures a JWT secret exists even when no .env is present (e.g. CI)."""
    monkeypatch.setattr(config, "JWT_SECRET_KEY", "unit-test-secret-key-not-for-production")


@pytest.fixture()
def db_session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # single shared in-memory DB across connections
    )
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    engine.dispose()


@pytest.fixture()
def client(db_session_factory):
    app = FastAPI()
    app.include_router(auth_router)

    def override_get_db():
        db = db_session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app)


VALID_SIGNUP = {
    "full_name": "Ada Lovelace",
    "email": "ada@example.com",
    "password": "Analytical1Engine",
}


def signup(client, **overrides):
    payload = {**VALID_SIGNUP, **overrides}
    return client.post("/api/auth/signup", json=payload)


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Security primitives
# ---------------------------------------------------------------------------

class TestSecurity:
    def test_password_hash_roundtrip(self):
        hashed = security.hash_password("S3cretPass")
        assert hashed != "S3cretPass"
        assert security.verify_password("S3cretPass", hashed)
        assert not security.verify_password("WrongPass1", hashed)

    def test_verify_password_tolerates_malformed_hash(self):
        assert security.verify_password("anything1", "not-a-bcrypt-hash") is False

    def test_access_token_roundtrip(self):
        token = security.create_access_token(42, "admin", "x@example.com")
        payload = security.decode_access_token(token)
        assert payload["sub"] == "42"
        assert payload["role"] == "admin"
        assert payload["type"] == "access"

    def test_expired_access_token_rejected(self, monkeypatch):
        monkeypatch.setattr(config, "ACCESS_TOKEN_EXPIRE_MINUTES", -1)
        token = security.create_access_token(1, "user", "x@example.com")
        with pytest.raises(security.TokenError, match="expired"):
            security.decode_access_token(token)

    def test_tampered_token_rejected(self):
        token = security.create_access_token(1, "user", "x@example.com")
        with pytest.raises(security.TokenError):
            security.decode_access_token(token[:-2] + "xx")

    def test_refresh_token_hash_is_deterministic_and_opaque(self):
        raw = security.generate_refresh_token()
        assert len(raw) >= 48
        assert security.hash_refresh_token(raw) == security.hash_refresh_token(raw)
        assert raw not in security.hash_refresh_token(raw)


# ---------------------------------------------------------------------------
# Signup
# ---------------------------------------------------------------------------

class TestSignup:
    def test_first_user_becomes_admin(self, client):
        res = signup(client)
        assert res.status_code == 201
        body = res.json()
        assert body["user"]["role"] == "admin"
        assert body["access_token"] and body["refresh_token"]

    def test_second_user_is_regular_user(self, client):
        signup(client)
        res = signup(client, email="second@example.com")
        assert res.status_code == 201
        assert res.json()["user"]["role"] == "user"

    def test_duplicate_email_conflict(self, client):
        signup(client)
        res = signup(client)
        assert res.status_code == 409

    def test_email_is_case_insensitive_unique(self, client):
        signup(client)
        res = signup(client, email="ADA@example.com")
        assert res.status_code == 409

    def test_invalid_email_rejected(self, client):
        assert signup(client, email="not-an-email").status_code == 422

    @pytest.mark.parametrize("bad_password", ["short1", "alllettersonly", "1234567890"])
    def test_weak_passwords_rejected(self, client, bad_password):
        assert signup(client, password=bad_password).status_code == 422

    def test_password_never_returned(self, client):
        body = signup(client).json()
        assert "password" not in str(body["user"])
        assert "hashed_password" not in str(body["user"])


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

class TestLogin:
    def test_login_success(self, client):
        signup(client)
        res = client.post("/api/auth/login", json={
            "email": VALID_SIGNUP["email"], "password": VALID_SIGNUP["password"],
        })
        assert res.status_code == 200
        assert res.json()["user"]["email"] == VALID_SIGNUP["email"]

    def test_wrong_password_rejected(self, client):
        signup(client)
        res = client.post("/api/auth/login", json={
            "email": VALID_SIGNUP["email"], "password": "WrongPass1",
        })
        assert res.status_code == 401

    def test_unknown_email_rejected_with_same_error(self, client):
        res = client.post("/api/auth/login", json={
            "email": "ghost@example.com", "password": "Whatever1",
        })
        assert res.status_code == 401
        # Same message as wrong-password so the API does not leak which
        # emails are registered.
        assert "Incorrect email or password" in res.json()["detail"]


# ---------------------------------------------------------------------------
# Protected profile routes
# ---------------------------------------------------------------------------

class TestProfile:
    def test_me_requires_auth(self, client):
        assert client.get("/api/auth/me").status_code == 401

    def test_me_rejects_garbage_token(self, client):
        assert client.get("/api/auth/me", headers=auth_header("garbage")).status_code == 401

    def test_me_returns_profile(self, client):
        token = signup(client).json()["access_token"]
        res = client.get("/api/auth/me", headers=auth_header(token))
        assert res.status_code == 200
        assert res.json()["email"] == VALID_SIGNUP["email"]

    def test_update_name(self, client):
        token = signup(client).json()["access_token"]
        res = client.put("/api/auth/me", json={"full_name": "Grace Hopper"},
                         headers=auth_header(token))
        assert res.status_code == 200
        assert res.json()["full_name"] == "Grace Hopper"

    def test_change_password_requires_correct_current(self, client):
        token = signup(client).json()["access_token"]
        res = client.put("/api/auth/me", json={
            "current_password": "WrongPass1", "new_password": "NewPassw0rd",
        }, headers=auth_header(token))
        assert res.status_code == 401

    def test_change_password_flow(self, client):
        token = signup(client).json()["access_token"]
        res = client.put("/api/auth/me", json={
            "current_password": VALID_SIGNUP["password"], "new_password": "NewPassw0rd",
        }, headers=auth_header(token))
        assert res.status_code == 200

        old = client.post("/api/auth/login", json={
            "email": VALID_SIGNUP["email"], "password": VALID_SIGNUP["password"]})
        new = client.post("/api/auth/login", json={
            "email": VALID_SIGNUP["email"], "password": "NewPassw0rd"})
        assert old.status_code == 401
        assert new.status_code == 200


# ---------------------------------------------------------------------------
# Refresh-token rotation & logout
# ---------------------------------------------------------------------------

class TestRefreshAndLogout:
    def test_refresh_rotates_tokens(self, client):
        tokens = signup(client).json()
        res = client.post("/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
        assert res.status_code == 200
        fresh = res.json()
        assert fresh["refresh_token"] != tokens["refresh_token"]
        assert fresh["access_token"]

    def test_reusing_rotated_token_revokes_all_sessions(self, client):
        tokens = signup(client).json()
        fresh = client.post("/api/auth/refresh",
                            json={"refresh_token": tokens["refresh_token"]}).json()
        # Reuse of the OLD (revoked) token → theft response
        reuse = client.post("/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
        assert reuse.status_code == 401
        # The NEW token must also have been revoked as part of the response
        after = client.post("/api/auth/refresh", json={"refresh_token": fresh["refresh_token"]})
        assert after.status_code == 401

    def test_unknown_refresh_token_rejected(self, client):
        res = client.post("/api/auth/refresh", json={"refresh_token": "x" * 64})
        assert res.status_code == 401

    def test_logout_revokes_refresh_token(self, client):
        tokens = signup(client).json()
        res = client.post("/api/auth/logout", json={"refresh_token": tokens["refresh_token"]})
        assert res.status_code == 200
        assert res.json()["sessions_revoked"] == 1
        # Token unusable afterwards
        res = client.post("/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
        assert res.status_code == 401

    def test_logout_is_idempotent(self, client):
        tokens = signup(client).json()
        client.post("/api/auth/logout", json={"refresh_token": tokens["refresh_token"]})
        res = client.post("/api/auth/logout", json={"refresh_token": tokens["refresh_token"]})
        assert res.status_code == 200
        assert res.json()["sessions_revoked"] == 0

    def test_logout_everywhere(self, client):
        signup(client)
        login = lambda: client.post("/api/auth/login", json={
            "email": VALID_SIGNUP["email"], "password": VALID_SIGNUP["password"]}).json()
        s1, s2 = login(), login()
        res = client.post("/api/auth/logout",
                          json={"refresh_token": s2["refresh_token"], "everywhere": True})
        assert res.status_code == 200
        assert res.json()["sessions_revoked"] >= 2
        for s in (s1, s2):
            assert client.post("/api/auth/refresh",
                               json={"refresh_token": s["refresh_token"]}).status_code == 401


# ---------------------------------------------------------------------------
# Role-based access control
# ---------------------------------------------------------------------------

class TestRBAC:
    def test_admin_can_list_users(self, client):
        admin_token = signup(client).json()["access_token"]  # first user = admin
        res = client.get("/api/auth/users", headers=auth_header(admin_token))
        assert res.status_code == 200
        assert len(res.json()) == 1

    def test_regular_user_gets_403(self, client):
        signup(client)
        user_token = signup(client, email="user2@example.com").json()["access_token"]
        res = client.get("/api/auth/users", headers=auth_header(user_token))
        assert res.status_code == 403

    def test_inactive_user_rejected(self, client, db_session_factory):
        token = signup(client).json()["access_token"]
        db = db_session_factory()
        user = db.query(User).filter_by(email=VALID_SIGNUP["email"]).one()
        user.is_active = False
        db.commit()
        db.close()

        assert client.get("/api/auth/me", headers=auth_header(token)).status_code == 403
        res = client.post("/api/auth/login", json={
            "email": VALID_SIGNUP["email"], "password": VALID_SIGNUP["password"]})
        assert res.status_code == 403
