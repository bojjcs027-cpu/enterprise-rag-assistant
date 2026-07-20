"""
Business logic for authentication.

Raises typed exceptions; the router maps them to HTTP responses. This keeps
the rules (token rotation, reuse detection, role bootstrap) independent of
FastAPI and directly unit-testable.
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from src import config
from src.auth import security
from src.auth.models import RefreshToken, User, UserRole
from src.auth.repository import RefreshTokenRepository, UserRepository
from src.auth.schemas import (
    LoginRequest,
    ProfileUpdateRequest,
    SignupRequest,
    TokenResponse,
    UserResponse,
)

logger = logging.getLogger(__name__)


class AuthError(Exception):
    """Base class; carries an HTTP-ish status for the router to translate."""
    status_code = 400

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class EmailAlreadyRegistered(AuthError):
    status_code = 409


class InvalidCredentials(AuthError):
    status_code = 401


class InvalidRefreshToken(AuthError):
    status_code = 401


class InactiveUser(AuthError):
    status_code = 403


class AuthService:
    def __init__(self, db: Session):
        self.users = UserRepository(db)
        self.tokens = RefreshTokenRepository(db)

    # ------------------------------------------------------------------
    # Signup / Login
    # ------------------------------------------------------------------

    def signup(self, req: SignupRequest) -> TokenResponse:
        email = req.email.lower()
        if self.users.get_by_email(email):
            raise EmailAlreadyRegistered("An account with this email already exists.")

        # Bootstrap rule: the very first account becomes the admin.
        role = UserRole.ADMIN if self.users.count() == 0 else UserRole.USER

        user = self.users.add(
            User(
                email=email,
                full_name=req.full_name,
                hashed_password=security.hash_password(req.password),
                role=role,
            )
        )
        logger.info("[Auth] New signup: %s (id=%d, role=%s)", email, user.id, role.value)
        return self._issue_tokens(user)

    def login(self, req: LoginRequest) -> TokenResponse:
        user = self.users.get_by_email(req.email)
        # Verify against a constant dummy hash when the user is unknown so
        # response timing does not reveal whether the email exists.
        if user is None:
            security.verify_password(req.password, _DUMMY_HASH)
            logger.warning("[Auth] Login failed (unknown email): %s", req.email)
            raise InvalidCredentials("Incorrect email or password.")

        if not security.verify_password(req.password, user.hashed_password):
            logger.warning("[Auth] Login failed (bad password): %s", req.email)
            raise InvalidCredentials("Incorrect email or password.")

        if not user.is_active:
            raise InactiveUser("This account has been deactivated.")

        logger.info("[Auth] Login OK: %s (remember=%s)", user.email, req.remember)
        return self._issue_tokens(user)

    # ------------------------------------------------------------------
    # Refresh / Logout
    # ------------------------------------------------------------------

    def refresh(self, refresh_token: str) -> TokenResponse:
        record = self.tokens.get_by_hash(security.hash_refresh_token(refresh_token))
        if record is None:
            raise InvalidRefreshToken("Unknown refresh token.")

        if record.is_revoked:
            # Rotation reuse = likely token theft: kill every session.
            revoked = self.tokens.revoke_all_for_user(record.user_id)
            logger.warning(
                "[Auth] Revoked refresh token REUSED for user_id=%d — revoked %d active sessions.",
                record.user_id, revoked,
            )
            raise InvalidRefreshToken("Refresh token has been revoked. Please log in again.")

        expires_at = record.expires_at
        if expires_at.tzinfo is None:  # SQLite returns naive datetimes
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            raise InvalidRefreshToken("Refresh token has expired. Please log in again.")

        user = self.users.get_by_id(record.user_id)
        if user is None or not user.is_active:
            raise InactiveUser("This account has been deactivated.")

        # Rotate: revoke the presented token, issue a fresh pair.
        self.tokens.revoke(record)
        logger.info("[Auth] Token refreshed for %s", user.email)
        return self._issue_tokens(user)

    def logout(self, refresh_token: str, everywhere: bool = False) -> int:
        """Revokes the presented refresh token (or all of the user's tokens).
        Idempotent: unknown tokens are ignored. Returns sessions revoked."""
        record = self.tokens.get_by_hash(security.hash_refresh_token(refresh_token))
        if record is None:
            return 0
        if everywhere:
            count = self.tokens.revoke_all_for_user(record.user_id)
            logger.info("[Auth] Logout-everywhere for user_id=%d (%d sessions)", record.user_id, count)
            return count
        if not record.is_revoked:
            self.tokens.revoke(record)
            logger.info("[Auth] Logout for user_id=%d", record.user_id)
            return 1
        return 0

    # ------------------------------------------------------------------
    # Profile
    # ------------------------------------------------------------------

    def update_profile(self, user: User, req: ProfileUpdateRequest) -> UserResponse:
        if req.full_name:
            user.full_name = req.full_name.strip()

        if req.new_password:
            if not req.current_password or not security.verify_password(
                req.current_password, user.hashed_password
            ):
                raise InvalidCredentials("Current password is incorrect.")
            user.hashed_password = security.hash_password(req.new_password)
            # Changing the password invalidates every other session.
            self.tokens.revoke_all_for_user(user.id)
            logger.info("[Auth] Password changed for %s — all sessions revoked", user.email)

        self.users.save(user)
        return UserResponse.model_validate(user)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _issue_tokens(self, user: User) -> TokenResponse:
        access = security.create_access_token(user.id, user.role.value, user.email)
        refresh_raw = security.generate_refresh_token()
        self.tokens.add(
            RefreshToken(
                user_id=user.id,
                token_hash=security.hash_refresh_token(refresh_raw),
                expires_at=datetime.now(timezone.utc)
                + timedelta(days=config.REFRESH_TOKEN_EXPIRE_DAYS),
            )
        )
        return TokenResponse(
            access_token=access,
            refresh_token=refresh_raw,
            expires_in=config.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            user=UserResponse.model_validate(user),
        )


# Fixed bcrypt hash of a random value — used only for timing equalisation.
_DUMMY_HASH = security.hash_password("timing-equalisation-dummy-value")
