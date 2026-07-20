"""
In-memory sliding-window rate limiting for the auth endpoints.

Guards login/signup against brute-force and enumeration. Keyed by client IP
per route. Suitable for a single-process deployment (which is how this app
runs); swap for a Redis-backed limiter when scaling horizontally.
"""

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status

from src import config


class SlidingWindowLimiter:
    def __init__(self, max_requests: int, window_seconds: float):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> float | None:
        """Records a hit for key. Returns None when allowed, otherwise the
        number of seconds until the oldest hit leaves the window."""
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            cutoff = now - self.window_seconds
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= self.max_requests:
                return self.window_seconds - (now - hits[0])
            hits.append(now)
            return None

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


login_limiter = SlidingWindowLimiter(
    max_requests=config.RATE_LIMIT_AUTH_ATTEMPTS,
    window_seconds=config.RATE_LIMIT_AUTH_WINDOW_SECONDS,
)


def _client_ip(request: Request) -> str:
    if request.client:
        return request.client.host
    return "unknown"


def rate_limit_auth(request: Request) -> None:
    """FastAPI dependency: 429 with Retry-After when the window is exhausted."""
    key = f"{_client_ip(request)}:{request.url.path}"
    retry_after = login_limiter.check(key)
    if retry_after is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please try again later.",
            headers={"Retry-After": str(max(1, int(retry_after + 0.5)))},
        )
