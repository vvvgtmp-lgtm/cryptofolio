from typing import Any

import httpx

from ..metrics import UPSTREAM_ERRORS
from .base import Coin, ProviderError, Quote, UnknownCoinError


class CoinGeckoProvider:
    """Real prices from the CoinGecko public API (free "demo" key optional)."""

    def __init__(
        self,
        base_url: str,
        api_key: str = "",
        transport: httpx.BaseTransport | None = None,
        timeout: float = 10.0,
    ):
        headers = {"accept": "application/json"}
        if api_key:
            headers["x-cg-demo-api-key"] = api_key
        self._client = httpx.Client(
            base_url=base_url, headers=headers, timeout=timeout, transport=transport
        )

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        try:
            response = self._client.get(path, params=params)
        except httpx.HTTPError as exc:
            UPSTREAM_ERRORS.labels("coingecko").inc()
            raise ProviderError(f"coingecko unreachable: {exc}") from exc
        if response.status_code == 404:
            raise UnknownCoinError(path)
        if response.status_code >= 400:
            UPSTREAM_ERRORS.labels("coingecko").inc()
            raise ProviderError(f"coingecko returned HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            UPSTREAM_ERRORS.labels("coingecko").inc()
            raise ProviderError("coingecko returned invalid JSON") from exc

    def list_coins(self) -> list[Coin]:
        data = self._get(
            "/coins/markets",
            {"vs_currency": "usd", "order": "market_cap_desc", "per_page": 100, "page": 1},
        )
        return [
            Coin(
                id=c["id"],
                symbol=c["symbol"],
                name=c["name"],
                image=c.get("image"),
                current_price=float(c.get("current_price") or 0),
                change_24h=round(float(c.get("price_change_percentage_24h") or 0), 2),
                market_cap=float(c.get("market_cap") or 0),
            )
            for c in data
        ]

    def get_prices(self, ids: list[str]) -> dict[str, Quote]:
        if not ids:
            return {}
        data = self._get(
            "/simple/price",
            {"ids": ",".join(ids), "vs_currencies": "usd", "include_24hr_change": "true"},
        )
        return {
            coin_id: Quote(
                usd=float(values["usd"]),
                change_24h=round(float(values.get("usd_24h_change") or 0), 2),
            )
            for coin_id, values in data.items()
            if "usd" in values
        }

    def get_history(self, coin_id: str, days: int) -> list[tuple[int, float]]:
        data = self._get(f"/coins/{coin_id}/market_chart", {"vs_currency": "usd", "days": days})
        return [(int(ts), float(price)) for ts, price in data["prices"]]
