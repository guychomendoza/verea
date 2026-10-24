"""
Requests per client per minute, counted in memory (the API runs on one machine): keeps one
visitor or script from monopolising the elevation and coverage calculations. Heavy endpoints get
their own, lower limits; /api/health is never limited.

The client is its IP as the edge reports it: Cloudflare (CF-Connecting-IP) when the API is behind
it, else Fly's proxy (Fly-Client-IP), else the socket. Over the limit: 429 with Retry-After.
"""

import os
import threading
import time
from collections import deque

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

WINDOW_S = 60
DEFAULT_LIMIT = int(os.environ.get("VEREA_RATE_LIMIT", "240"))    # every other endpoint, together
HEAVY_LIMITS = {"/api/coverage": 20, "/api/suggest-gateways": 10, "/api/radial": 60}
EXEMPT = {"/api/health"}


def client_key(request) -> str:
    h = request.headers
    return h.get("cf-connecting-ip") or h.get("fly-client-ip") or (request.client.host if request.client else "?")


class RateLimit(BaseHTTPMiddleware):
    def __init__(self, app, limits: dict | None = None, default: int = DEFAULT_LIMIT, clock=time.monotonic):
        super().__init__(app)
        self.limits = HEAVY_LIMITS if limits is None else limits
        self.default = default
        self.clock = clock
        self.hits: dict[tuple[str, str], deque] = {}
        self.lock = threading.Lock()
        self.calls = 0

    async def dispatch(self, request, call_next):
        path = request.url.path
        if request.method == "OPTIONS" or path in EXEMPT or not path.startswith("/api/"):
            return await call_next(request)
        bucket = path if path in self.limits else "*"
        limit = self.limits.get(path, self.default)
        now = self.clock()
        with self.lock:
            q = self.hits.setdefault((client_key(request), bucket), deque())
            while q and now - q[0] >= WINDOW_S:
                q.popleft()
            if len(q) >= limit:
                retry = int(WINDOW_S - (now - q[0])) + 1
                return JSONResponse({"detail": "Demasiadas peticiones seguidas: espera un momento y vuelve a intentar."},
                                    status_code=429, headers={"Retry-After": str(retry)})
            q.append(now)
            self.calls += 1
            if self.calls % 1000 == 0:          # forget clients that went quiet
                for k in [k for k, v in self.hits.items() if not v or now - v[-1] >= WINDOW_S]:
                    del self.hits[k]
        return await call_next(request)
