"""
Sliding-window rate limiting for the auth endpoints.

Guards login/signup against brute-force and enumeration, keyed by client IP
per route. Uses Redis (shared across processes) when REDIS_URL is set and
reachable; otherwise — and on any Redis error — an in-memory window, so
throttling always works.
"""

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status

from src import config, redis_backend


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

    # ------------------------------------------------------------------
    # Redis sliding window (shared across workers)
    # ------------------------------------------------------------------

    def _check_redis(self, r, key: str) -> float | None:
        """Same contract as check(), backed by a Redis sorted set whose
        scores are hit timestamps. Raises on Redis errors (caller falls
        back to the in-memory window)."""
        rkey = f"rag:ratelimit:{key}"
        now = time.time()
        cutoff = now - self.window_seconds

        pipe = r.pipeline()
        pipe.zremrangebyscore(rkey, 0, cutoff)
        pipe.zcard(rkey)
        _, count = pipe.execute()

        if count >= self.max_requests:
            oldest = r.zrange(rkey, 0, 0, withscores=True)
            oldest_ts = oldest[0][1] if oldest else now
            return self.window_seconds - (now - oldest_ts)

        pipe = r.pipeline()
        pipe.zadd(rkey, {f"{now}:{id(pipe)}": now})
        pipe.expire(rkey, int(self.window_seconds) + 1)
        pipe.execute()
        return None

    def check_any(self, key: str) -> float | None:
        """Redis-backed check when available, in-memory otherwise."""
        r = redis_backend.get_redis()
        if r is not None:
            try:
                return self._check_redis(r, key)
            except Exception:
                pass  # Redis hiccup — never leave the endpoint unthrottled
        return self.check(key)


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
    retry_after = login_limiter.check_any(key)
    if retry_after is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please try again later.",
            headers={"Retry-After": str(max(1, int(retry_after + 0.5)))},
        )
