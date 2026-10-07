from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All configuration comes from environment variables (e.g. PRICE_PROVIDER)."""

    price_provider: Literal["mock", "binance", "coingecko"] = "mock"
    binance_base_url: str = "https://data-api.binance.vision"
    coingecko_base_url: str = "https://api.coingecko.com/api/v3"
    coingecko_api_key: str = ""
    redis_url: str = "redis://localhost:6379/0"
    log_level: str = "info"
    prices_ttl_seconds: int = 60
