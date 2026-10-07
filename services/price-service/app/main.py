import logging
import time
import uuid
from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from redis import Redis

from .cache import PriceService
from .config import Settings
from .logging_setup import setup_logging
from .metrics import REQUESTS
from .providers.base import HISTORY_DAYS, ProviderError, UnknownCoinError
from .providers.binance import BinanceProvider
from .providers.coingecko import CoinGeckoProvider
from .providers.mock import MockProvider

log = logging.getLogger("price-service")
QUIET_PATHS = {"/healthz", "/readyz", "/metrics"}


def build_service(settings: Settings, redis: Redis) -> PriceService:
    if settings.price_provider == "coingecko":
        provider = CoinGeckoProvider(settings.coingecko_base_url, settings.coingecko_api_key)
    elif settings.price_provider == "binance":
        provider = BinanceProvider(settings.binance_base_url)
    else:
        provider = MockProvider()
    return PriceService(
        provider, redis, prices_ttl=settings.prices_ttl_seconds, key_prefix=settings.price_provider
    )


def create_app(
    settings: Settings | None = None,
    redis: Redis | None = None,
    service: PriceService | None = None,
) -> FastAPI:
    settings = settings or Settings()
    setup_logging(settings.log_level)
    redis = redis or Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=2)
    service = service or build_service(settings, redis)
    log.info("starting", extra={"provider": settings.price_provider})

    app = FastAPI(title="CryptoFolio price-service", version="1.0.0")

    @app.middleware("http")
    async def observe(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        start = time.perf_counter()
        response = await call_next(request)
        duration = time.perf_counter() - start
        route = getattr(request.scope.get("route"), "path", "unmatched")
        REQUESTS.labels(request.method, route, str(response.status_code)).observe(duration)
        response.headers["x-request-id"] = request_id
        if route not in QUIET_PATHS:
            log.info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "duration_ms": round(duration * 1000, 1),
                },
            )
        return response

    @app.exception_handler(ProviderError)
    async def provider_error(_request: Request, exc: ProviderError):
        log.warning("provider error: %s", exc)
        return JSONResponse(status_code=503, content={"detail": "price provider unavailable"})

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz():
        try:
            redis.ping()
        except Exception:
            return JSONResponse(
                status_code=503, content={"status": "not_ready", "checks": {"redis": "error"}}
            )
        return {"status": "ready", "checks": {"redis": "ok"}}

    @app.get("/metrics")
    def metrics():
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.get("/coins")
    def coins():
        items, stale = service.coins()
        return {"coins": [asdict(c) for c in items], "stale": stale}

    @app.get("/prices")
    def prices(ids: str):
        id_list = [i.strip().lower() for i in ids.split(",") if i.strip()]
        if not 1 <= len(id_list) <= 100:
            raise HTTPException(400, "ids must contain 1-100 coin ids")
        quotes, stale = service.prices(id_list)
        return {"prices": {k: asdict(v) for k, v in quotes.items()}, "stale": stale}

    @app.get("/history/{coin_id}")
    def history(coin_id: str, days: int = 7):
        if days not in HISTORY_DAYS:
            raise HTTPException(400, f"days must be one of {list(HISTORY_DAYS)}")
        try:
            points, stale = service.history(coin_id, days)
        except UnknownCoinError:
            raise HTTPException(404, f"unknown coin: {coin_id}") from None
        return {"id": coin_id, "days": days, "points": points, "stale": stale}

    return app
