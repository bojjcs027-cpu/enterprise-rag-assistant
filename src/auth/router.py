"""HTTP layer for authentication. Thin: validation via schemas, logic via
AuthService, error translation via a single exception handler."""

import logging
from typing import Annotated, List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from src.auth.dependencies import AdminUser, CurrentUser
from src.auth.rate_limit import rate_limit_auth
from src.auth.schemas import (
    LoginRequest,
    LogoutRequest,
    ProfileUpdateRequest,
    RefreshRequest,
    SignupRequest,
    TokenResponse,
    UserResponse,
)
from src.auth.service import AuthError, AuthService
from src.db import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _service(db: Annotated[Session, Depends(get_db)]) -> AuthService:
    return AuthService(db)


Service = Annotated[AuthService, Depends(_service)]


def _run(fn, *args):
    """Executes a service call, translating AuthError into HTTPException."""
    try:
        return fn(*args)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post(
    "/signup",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit_auth)],
)
def signup(req: SignupRequest, service: Service):
    """Creates an account and logs the user straight in.
    The first account ever created becomes the administrator."""
    return _run(service.signup, req)


@router.post("/login", response_model=TokenResponse, dependencies=[Depends(rate_limit_auth)])
def login(req: LoginRequest, service: Service):
    return _run(service.login, req)


@router.post("/refresh", response_model=TokenResponse)
def refresh(req: RefreshRequest, service: Service):
    """Exchanges a valid refresh token for a new access/refresh pair.
    The presented token is revoked (rotation); reusing a revoked token
    revokes every session for that user."""
    return _run(service.refresh, req.refresh_token)


@router.post("/logout")
def logout(req: LogoutRequest, service: Service):
    """Revokes the refresh token (or all of the user's sessions). Idempotent."""
    revoked = _run(service.logout, req.refresh_token, req.everywhere)
    return {"message": "Logged out.", "sessions_revoked": revoked}


@router.get("/me", response_model=UserResponse)
def get_profile(user: CurrentUser):
    return user


@router.put("/me", response_model=UserResponse)
def update_profile(req: ProfileUpdateRequest, user: CurrentUser, service: Service):
    return _run(service.update_profile, user, req)


@router.get("/users", response_model=List[UserResponse])
def list_users(_: AdminUser, service: Service):
    """Admin-only: lists all registered users."""
    return service.users.list_all()
