"""
Optional shared Redis connection.

Enabled by setting REDIS_URL in .env (e.g. redis://localhost:6379/0).
Every consumer (semantic cache, retrieval cache, rate limiter) treats Redis
as best-effort: if the server is unreachable at startup or any operation
fails at runtime, the caller falls back to its in-memory implementation, so
the application never hard-depends on Redis being up.
"""

import logging

from src import config

logger = logging.getLogger(__name__)

_client = None
_checked = False


def get_redis():
    """Returns a connected Redis client, or None to use in-memory fallbacks.

    The connection is attempted once per process; a failed attempt logs a
    warning and permanently selects the fallback (restart to retry).
    """
    global _client, _checked
    if _checked:
        return _client
    _checked = True

    if not config.REDIS_URL:
        return None

    try:
        import redis
        client = redis.Redis.from_url(
            config.REDIS_URL,
            socket_connect_timeout=2,
            socket_timeout=2,
            decode_responses=False,  # values are pickled bytes
        )
        client.ping()
        _client = client
        logger.info("[Redis] Connected to %s", config.REDIS_URL)
    except Exception as exc:
        logger.warning(
            "[Redis] Unavailable (%s) — falling back to in-memory caches/limits.", exc
        )
        _client = None
    return _client


def reset_for_tests():
    """Clears the cached connection state (used by unit tests)."""
    global _client, _checked
    _client = None
    _checked = False
