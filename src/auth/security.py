"""
Password hashing and JWT primitives.

Pure functions with no FastAPI/SQLAlchemy dependencies so they can be unit
tested in isolation and reused outside the web layer (SOLID: single
responsibility, dependency inversion — upper layers depend on this, not the
other way round).
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

import bcrypt
import jwt

from src import config


class TokenError(Exception):
    """Raised when a JWT is invalid, expired, or of the wrong type."""


# ---------------------------------------------------------------------------
# Password hashing (bcrypt)
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    # bcrypt operates on bytes and ignores input past 72 bytes; reject longer
    # passwords at the schema layer rather than silently truncating here.
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        # Malformed hash in storage — treat as authentication failure.
        return False


# ---------------------------------------------------------------------------
# Access tokens (JWT)
# ---------------------------------------------------------------------------

def _require_secret() -> str:
    if not config.JWT_SECRET_KEY:
        raise TokenError(
            "JWT_SECRET_KEY is not configured. Set it in .env before starting the server."
        )
    return config.JWT_SECRET_KEY


def create_access_token(user_id: int, role: str, email: str) -> str:
    now = datetime.now(timezone.utc)
    payload: Dict[str, Any] = {
        "sub": str(user_id),
        "role": role,
        "email": email,
        "type": "access",
        "iat": now,
        "exp": now + timedelta(minutes=config.ACCESS_TOKEN_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, _require_secret(), algorithm=config.JWT_ALGORITHM)


def decode_access_token(token: str) -> Dict[str, Any]:
    """Decodes and validates an access token. Raises TokenError on any problem."""
    try:
        payload = jwt.decode(token, _require_secret(), algorithms=[config.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError as exc:
        raise TokenError("Access token has expired.") from exc
    except jwt.InvalidTokenError as exc:
        raise TokenError("Invalid access token.") from exc

    if payload.get("type") != "access":
        raise TokenError("Token is not an access token.")
    if "sub" not in payload:
        raise TokenError("Token is missing the subject claim.")
    return payload


# ---------------------------------------------------------------------------
# Refresh tokens (opaque, stored hashed server-side)
# ---------------------------------------------------------------------------

def generate_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
