"""Deterministic, offline price feed for classrooms.

Price is a pure function of (coin id, timestamp): a sum of sine waves with a
per-coin phase. Same inputs -> same output, prices move minute to minute (so
alerts can trigger) and never drift more than ~12% from the base price.
"""

import hashlib
import math
import time
from collections.abc import Callable

from .base import Coin, Quote, UnknownCoinError
from .catalogue import CATALOGUE, DAY, HISTORY_STEP_SECONDS, STABLECOINS

MOCK_COINS = CATALOGUE


def _phase(coin_id: str) -> float:
    digest = hashlib.sha256(coin_id.encode()).digest()
    return int.from_bytes(digest[:4], "big") / 2**32 * 2 * math.pi


def price_at(coin_id: str, base: float, ts: float) -> float:
    p = _phase(coin_id)
    if coin_id in STABLECOINS:
        return round(base * (1 + 0.001 * math.sin(ts / 3600 + p)), 6)
    wave = (
        0.08 * math.sin(2 * math.pi * ts / (7 * DAY) + p)
        + 0.03 * math.sin(2 * math.pi * ts / DAY + 2 * p)
        + 0.01 * math.sin(2 * math.pi * ts / 3600 + 3 * p)
        + 0.004 * math.sin(2 * math.pi * ts / 300 + 5 * p)
    )
    return round(base * (1 + wave), 6 if base < 1 else 2)


class MockProvider:
    def __init__(self, clock: Callable[[], float] = time.time):
        self._clock = clock
        self._coins = {c[0]: c for c in MOCK_COINS}

    def _quote(self, coin_id: str, now: float) -> Quote:
        base = self._coins[coin_id][3]
        current = price_at(coin_id, base, now)
        previous = price_at(coin_id, base, now - DAY)
        return Quote(usd=current, change_24h=round((current - previous) / previous * 100, 2))

    def list_coins(self) -> list[Coin]:
        now = self._clock()
        coins = []
        for coin_id, symbol, name, _base, supply in MOCK_COINS:
            quote = self._quote(coin_id, now)
            coins.append(
                Coin(
                    id=coin_id,
                    symbol=symbol,
                    name=name,
                    image=None,
                    current_price=quote.usd,
                    change_24h=quote.change_24h,
                    market_cap=round(quote.usd * supply),
                )
            )
        return sorted(coins, key=lambda c: c.market_cap, reverse=True)

    def get_prices(self, ids: list[str]) -> dict[str, Quote]:
        now = self._clock()
        return {i: self._quote(i, now) for i in ids if i in self._coins}

    def get_history(self, coin_id: str, days: int) -> list[tuple[int, float]]:
        if coin_id not in self._coins:
            raise UnknownCoinError(coin_id)
        if days not in HISTORY_STEP_SECONDS:
            raise ValueError(f"unsupported days: {days}")
        base = self._coins[coin_id][3]
        now = self._clock()
        step = HISTORY_STEP_SECONDS[days]
        end = int(now // step * step)
        count = days * DAY // step
        points = [
            (int((end - k * step) * 1000), price_at(coin_id, base, end - k * step))
            for k in range(count, -1, -1)
        ]
        if now > end:
            points.append((int(now * 1000), price_at(coin_id, base, now)))
        return points
