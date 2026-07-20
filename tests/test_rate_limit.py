"""Tests for the auth sliding-window rate limiter."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src import config
from src.auth.rate_limit import SlidingWindowLimiter, login_limiter
from src.auth.router import router as auth_router
from src.db import Base, get_db


class TestSlidingWindowLimiter:
    def test_allows_up_to_max(self):
        limiter = SlidingWindowLimiter(max_requests=3, window_seconds=60)
        assert limiter.check("k") is None
        assert limiter.check("k") is None
        assert limiter.check("k") is None

    def test_blocks_after_max_and_reports_retry(self):
        limiter = SlidingWindowLimiter(max_requests=2, window_seconds=60)
        limiter.check("k")
        limiter.check("k")
        retry = limiter.check("k")
        assert retry is not None and 0 < retry <= 60

    def test_keys_are_independent(self):
        limiter = SlidingWindowLimiter(max_requests=1, window_seconds=60)
        assert limiter.check("a") is None
        assert limiter.check("b") is None
        assert limiter.check("a") is not None

    def test_window_expiry_frees_slots(self, monkeypatch):
        import src.auth.rate_limit as rl
        t = [1000.0]
        monkeypatch.setattr(rl.time, "monotonic", lambda: t[0])
        limiter = SlidingWindowLimiter(max_requests=1, window_seconds=10)
        assert limiter.check("k") is None
        assert limiter.check("k") is not None
        t[0] += 11  # advance past the window
        assert limiter.check("k") is None

    def test_reset_clears_state(self):
        limiter = SlidingWindowLimiter(max_requests=1, window_seconds=60)
        limiter.check("k")
        limiter.reset()
        assert limiter.check("k") is None


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(config, "JWT_SECRET_KEY", "unit-test-secret-key")
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    app = FastAPI()
    app.include_router(auth_router)

    def override_get_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    engine.dispose()


class TestAuthEndpointRateLimit:
    def test_login_429_after_limit(self, client, monkeypatch):
        monkeypatch.setattr(login_limiter, "max_requests", 3)
        for _ in range(3):
            resp = client.post(
                "/api/auth/login",
                json={"email": "nobody@example.com", "password": "wrongpass1"},
            )
            assert resp.status_code == 401
        resp = client.post(
            "/api/auth/login",
            json={"email": "nobody@example.com", "password": "wrongpass1"},
        )
        assert resp.status_code == 429
        assert "Retry-After" in resp.headers

    def test_signup_shares_limiter_but_separate_key(self, client, monkeypatch):
        monkeypatch.setattr(login_limiter, "max_requests", 1)
        # One login hit exhausts the login key…
        client.post("/api/auth/login", json={"email": "a@b.co", "password": "x1abcdef"})
        # …but signup (different path key) is still allowed once.
        resp = client.post(
            "/api/auth/signup",
            json={"full_name": "Ada L", "email": "ada2@example.com", "password": "Analytical1"},
        )
        assert resp.status_code == 201
        resp = client.post(
            "/api/auth/signup",
            json={"full_name": "Bob L", "email": "bob2@example.com", "password": "Analytical1"},
        )
        assert resp.status_code == 429
