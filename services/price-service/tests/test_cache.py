import fakeredis
import pytest

from app.cache import PriceService
from app.providers.base import Coin, ProviderError, Quote, UnknownCoinError


class FakeProvider:
    def __init__(self):
        self.fail = False
        self.requested: list[list[str]] = []
        self.quotes = {"bitcoin": Quote(50000.0, 1.5), "ethereum": Quote(3000.0, -2.0)}

    def _maybe_fail(self):
        if self.fail:
            raise ProviderError("upstream down")

    def list_coins(self):
        self._maybe_fail()
        return [Coin("bitcoin", "btc", "Bitcoin", None, 50000.0, 1.5, 1e12)]

    def get_prices(self, ids):
        self._maybe_fail()
        self.requested.append(list(ids))
        return {i: self.quotes[i] for i in ids if i in self.quotes}

    def get_history(self, coin_id, days):
        self._maybe_fail()
        if coin_id != "bitcoin":
            raise UnknownCoinError(coin_id)
        return [(1000, 1.0), (2000, 2.0)]


@pytest.fixture
def redis():
    return fakeredis.FakeRedis(decode_responses=True)


@pytest.fixture
def provider():
    return FakeProvider()


@pytest.fixture
def service(provider, redis):
    return PriceService(provider, redis)


def test_prices_second_call_is_served_from_cache(service, provider):
    service.prices(["bitcoin"])
    quotes, stale = service.prices(["bitcoin"])
    assert quotes == {"bitcoin": Quote(50000.0, 1.5)}
    assert stale is False
    assert provider.requested == [["bitcoin"]]


def test_prices_only_fetches_missing_ids(service, provider):
    service.prices(["bitcoin"])
    service.prices(["bitcoin", "ethereum"])
    assert provider.requested == [["bitcoin"], ["ethereum"]]


def test_prices_cache_entries_expire(service, redis):
    service.prices(["bitcoin"])
    assert 0 < redis.ttl("cache:price:bitcoin") <= 60
    assert redis.ttl("lkg:price:bitcoin") == -1


def test_prices_serve_last_known_good_when_provider_down(service, provider, redis):
    service.prices(["bitcoin"])
    redis.delete("cache:price:bitcoin")
    provider.fail = True
    quotes, stale = service.prices(["bitcoin"])
    assert quotes["bitcoin"].usd == 50000.0
    assert stale is True


def test_prices_raise_when_provider_down_and_nothing_cached(service, provider):
    provider.fail = True
    with pytest.raises(ProviderError):
        service.prices(["bitcoin"])


def test_unknown_ids_are_not_returned(service):
    quotes, _ = service.prices(["bitcoin", "nope"])
    assert set(quotes) == {"bitcoin"}


def test_coins_fall_back_to_last_known_good(service, provider, redis):
    service.coins()
    redis.delete("cache:coins")
    provider.fail = True
    coins, stale = service.coins()
    assert coins[0].id == "bitcoin"
    assert stale is True


def test_history_is_cached(service, redis):
    points, stale = service.history("bitcoin", 7)
    assert points == [[1000, 1.0], [2000, 2.0]]
    assert stale is False
    assert redis.exists("cache:history:bitcoin:7")


def test_history_unknown_coin_propagates(service):
    with pytest.raises(UnknownCoinError):
        service.history("nope", 7)


def test_cache_is_namespaced_per_provider(redis):
    mock_like, real_like = FakeProvider(), FakeProvider()
    real_like.quotes = {"bitcoin": Quote(99999.0, 0.0)}
    PriceService(mock_like, redis, key_prefix="mock").prices(["bitcoin"])
    quotes, _ = PriceService(real_like, redis, key_prefix="coingecko").prices(["bitcoin"])
    assert quotes["bitcoin"].usd == 99999.0
    assert redis.exists("cache:mock:price:bitcoin") and redis.exists("lkg:coingecko:price:bitcoin")
