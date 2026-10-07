"""Real prices from Binance's public market-data API: no key, no monthly quota.

Covers the coins in the shared catalogue (same ids as the mock provider), quoted in
USDT (~1 USD). Binance has no market caps or logos: market cap = price x circulating
supply from the catalogue, and the frontend falls back to letter icons.
"""

import json
import time
from collections.abc import Callable
from typing import Any

import httpx

from ..metrics import UPSTREAM_ERRORS
from .base import Coin, ProviderError, Quote, UnknownCoinError
from .catalogue import CATALOGUE, HISTORY_STEP_SECONDS

QUOTE_COIN = "tether"  # USDT is the quote currency of every pair
KLINE_INTERVAL = {1: "5m", 7: "1h", 30: "4h", 365: "1d"}


class BinanceProvider:
    def __init__(
        self,
        base_url: str,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 10.0,
        clock: Callable[[], float] = time.time,
    ):
        self._client = httpx.Client(base_url=base_url, timeout=timeout, transport=transport)
        self._clock = clock
        self._coins = {c[0]: c for c in CATALOGUE}

    @staticmethod
    def _pair(symbol: str) -> str:
        return f"{symbol.upper()}USDT"

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        try:
            response = self._client.get(path, params=params)
        except httpx.HTTPError as exc:
            UPSTREAM_ERRORS.labels("binance").inc()
            raise ProviderError(f"binance unreachable: {exc}") from exc
        if response.status_code >= 400:  # 418/429 = rate-limit bans, 400 = bad symbol
            UPSTREAM_ERRORS.labels("binance").inc()
            raise ProviderError(f"binance returned HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            UPSTREAM_ERRORS.labels("binance").inc()
            raise ProviderError("binance returned invalid JSON") from exc

    def _quotes(self, ids: list[str]) -> dict[str, Quote]:
        quotes = {i: Quote(1.0, 0.0) for i in ids if i == QUOTE_COIN}
        pairs = {
            self._pair(self._coins[i][1]): i for i in ids if i in self._coins and i != QUOTE_COIN
        }
        if pairs:
            symbols = json.dumps(sorted(pairs), separators=(",", ":"))
            for t in self._get("/api/v3/ticker/24hr", {"symbols": symbols}):
                coin_id = pairs.get(t.get("symbol"))
                if coin_id:
                    quotes[coin_id] = Quote(
                        usd=float(t["lastPrice"]),
                        change_24h=round(float(t["priceChangePercent"]), 2),
                    )
        return quotes

    def list_coins(self) -> list[Coin]:
        quotes = self._quotes(list(self._coins))
        coins = [
            Coin(
                id=coin_id,
                symbol=symbol,
                name=name,
                image=None,
                current_price=quotes[coin_id].usd,
                change_24h=quotes[coin_id].change_24h,
                market_cap=round(quotes[coin_id].usd * supply),
            )
            for coin_id, symbol, name, _base, supply in CATALOGUE
            if coin_id in quotes
        ]
        return sorted(coins, key=lambda c: c.market_cap, reverse=True)

    def get_prices(self, ids: list[str]) -> dict[str, Quote]:
        return self._quotes(ids)

    def get_history(self, coin_id: str, days: int) -> list[tuple[int, float]]:
        if coin_id not in self._coins:
            raise UnknownCoinError(coin_id)
        if days not in KLINE_INTERVAL:
            raise ValueError(f"unsupported days: {days}")
        step = HISTORY_STEP_SECONDS[days]
        limit = days * 86400 // step + 1
        if coin_id == QUOTE_COIN:
            end = int(self._clock() // step * step)
            return [(int((end - k * step) * 1000), 1.0) for k in range(limit - 1, -1, -1)]
        candles = self._get(
            "/api/v3/klines",
            {
                "symbol": self._pair(self._coins[coin_id][1]),
                "interval": KLINE_INTERVAL[days],
                "limit": limit,
            },
        )
        # kline = [open_time_ms, open, high, low, close, volume, ...]
        return [(int(k[0]), float(k[4])) for k in candles]
