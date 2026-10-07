"""Read-through Redis cache in front of a PriceProvider.

Every successful fetch is stored twice:
  cache:<key>  with a TTL  -> normal cache
  lkg:<key>    no TTL      -> "last known good", served (stale=True) if the provider fails
"""

import json
from collections.abc import Callable
from dataclasses import asdict
from typing import Any

from redis import Redis

from .metrics import CACHE_EVENTS
from .providers.base import Coin, PriceProvider, ProviderError, Quote


class PriceService:
    def __init__(
        self,
        provider: PriceProvider,
        redis: Redis,
        prices_ttl: int = 60,
        coins_ttl: int = 3600,
        history_ttl: int = 600,
        key_prefix: str = "",
    ):
        self._provider = provider
        # Namespace keys per provider so switching PRICE_PROVIDER never serves the other one's data.
        self._ns = f"{key_prefix}:" if key_prefix else ""
        self._redis = redis
        self._prices_ttl = prices_ttl
        self._coins_ttl = coins_ttl
        self._history_ttl = history_ttl

    def coins(self) -> tuple[list[Coin], bool]:
        raw, stale = self._cached(
            "coins", self._coins_ttl, lambda: [asdict(c) for c in self._provider.list_coins()]
        )
        return [Coin(**c) for c in raw], stale

    def history(self, coin_id: str, days: int) -> tuple[list[list[float]], bool]:
        return self._cached(
            f"history:{coin_id}:{days}",
            self._history_ttl,
            lambda: [[ts, price] for ts, price in self._provider.get_history(coin_id, days)],
        )

    def prices(self, ids: list[str]) -> tuple[dict[str, Quote], bool]:
        ids = sorted(set(ids))
        result: dict[str, Quote] = {}
        missing: list[str] = []
        cached = self._redis.mget([f"cache:{self._ns}price:{i}" for i in ids])
        for coin_id, raw in zip(ids, cached, strict=True):
            if raw is None:
                missing.append(coin_id)
            else:
                result[coin_id] = Quote(**json.loads(raw))
        CACHE_EVENTS.labels("hit").inc(len(result))
        if not missing:
            return result, False

        CACHE_EVENTS.labels("miss").inc(len(missing))
        try:
            fetched = self._provider.get_prices(missing)
        except ProviderError:
            stale_raw = self._redis.mget([f"lkg:{self._ns}price:{i}" for i in missing])
            for coin_id, raw in zip(missing, stale_raw, strict=True):
                if raw is not None:
                    result[coin_id] = Quote(**json.loads(raw))
            if not result:
                raise
            CACHE_EVENTS.labels("stale").inc()
            return result, True

        pipe = self._redis.pipeline()
        for coin_id, quote in fetched.items():
            encoded = json.dumps(asdict(quote))
            pipe.set(f"cache:{self._ns}price:{coin_id}", encoded, ex=self._prices_ttl)
            pipe.set(f"lkg:{self._ns}price:{coin_id}", encoded)
        pipe.execute()
        result.update(fetched)
        return result, False

    def _cached(self, key: str, ttl: int, fetch: Callable[[], Any]) -> tuple[Any, bool]:
        cached = self._redis.get(f"cache:{self._ns}{key}")
        if cached is not None:
            CACHE_EVENTS.labels("hit").inc()
            return json.loads(cached), False
        CACHE_EVENTS.labels("miss").inc()
        try:
            data = fetch()
        except ProviderError:
            last_known_good = self._redis.get(f"lkg:{self._ns}{key}")
            if last_known_good is None:
                raise
            CACHE_EVENTS.labels("stale").inc()
            return json.loads(last_known_good), True
        encoded = json.dumps(data)
        pipe = self._redis.pipeline()
        pipe.set(f"cache:{self._ns}{key}", encoded, ex=ttl)
        pipe.set(f"lkg:{self._ns}{key}", encoded)
        pipe.execute()
        return data, False
