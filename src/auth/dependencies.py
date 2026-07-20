"""
Authentication middleware, implemented as FastAPI dependencies.

`get_current_user` guards any route it is attached to (401 on missing/invalid
token); `require_admin` layers role-based access control on top (403).
"""

import logging
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from src.auth import security
from src.auth.models import User, UserRole
from src.db import get_db

logger = logging.getLogger(__name__)

# auto_error=False lets us return a clean 401 (with WWW-Authenticate) instead
# of FastAPI's default 403 when the header is missing entirely.
_bearer_scheme = HTTPBearer(auto_error=False)


def _credentials_error(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    if credentials is None:
        raise _credentials_error("Not authenticated.")

    try:
        payload = security.decode_access_token(credentials.credentials)
    except security.TokenError as exc:
        raise _credentials_error(str(exc))

    user = db.get(User, int(payload["sub"]))
    if user is None:
        raise _credentials_error("User no longer exists.")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account deactivated.")
    return user


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != UserRole.ADMIN:
        logger.warning("[Auth] RBAC denied: %s (role=%s) hit an admin route", user.email, user.role.value)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )
    return user


# Readable aliases for route signatures
CurrentUser = Annotated[User, Depends(get_current_user)]
AdminUser = Annotated[User, Depends(require_admin)]
