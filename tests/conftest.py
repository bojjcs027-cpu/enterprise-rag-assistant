"""
Shared pytest bootstrap.

torch is imported here, before any test module, because on some Windows
machines loading torch's c10.dll intermittently fails with WinError 1114
when the import first happens inside pytest's collection of a test module.
Importing it up front (outside assertion-rewritten modules) sidesteps that.
If torch is genuinely unavailable the tests that need it will fail with a
clear ImportError instead.
"""

try:
    import torch  # noqa: F401
except OSError:  # pragma: no cover — environment-specific DLL flakiness
    pass

import pytest


@pytest.fixture(autouse=True)
def reset_auth_rate_limiter():
    """Auth rate-limit state is process-global; every TestClient request comes
    from the same fake IP, so leftover hits would 429 unrelated tests."""
    from src.auth.rate_limit import login_limiter
    login_limiter.reset()
    yield
    login_limiter.reset()
