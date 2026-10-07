from dataclasses import dataclass
from typing import Protocol

HISTORY_DAYS = (1, 7, 30, 365)


@dataclass(frozen=True)
class Coin:
    id: str
    symbol: str
    name: str
    image: str | None
    current_price: float
    change_24h: float
    market_cap: float


@dataclass(frozen=True)
class Quote:
    usd: float
    change_24h: float


class ProviderError(Exception):
    """Upstream is unreachable, rate-limited or returned garbage."""


class UnknownCoinError(Exception):
    """The provider does not know this coin id."""


class PriceProvider(Protocol):
    def list_coins(self) -> list[Coin]: ...

    def get_prices(self, ids: list[str]) -> dict[str, Quote]: ...

    def get_history(self, coin_id: str, days: int) -> list[tuple[int, float]]: ...
