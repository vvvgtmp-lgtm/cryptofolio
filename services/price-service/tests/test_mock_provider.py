import pytest

from app.providers.base import UnknownCoinError
from app.providers.mock import MOCK_COINS, MockProvider

NOW = 1_760_000_000.0


def provider(ts: float = NOW) -> MockProvider:
    return MockProvider(clock=lambda: ts)


def test_prices_are_deterministic_for_same_timestamp():
    assert provider().get_prices(["bitcoin"]) == provider().get_prices(["bitcoin"])


def test_prices_move_over_time():
    a = provider(NOW).get_prices(["bitcoin"])["bitcoin"].usd
    b = provider(NOW + 5 * 3600).get_prices(["bitcoin"])["bitcoin"].usd
    assert a != b


def test_prices_stay_within_band_of_base_price():
    for coin_id, _symbol, _name, base, _supply in MOCK_COINS:
        for k in range(60):
            usd = provider(NOW + k * 7919).get_prices([coin_id])[coin_id].usd
            assert 0.85 * base <= usd <= 1.15 * base


def test_unknown_ids_are_omitted():
    assert set(provider().get_prices(["bitcoin", "not-a-coin"])) == {"bitcoin"}


def test_change_24h_matches_price_24h_ago():
    quote = provider(NOW).get_prices(["ethereum"])["ethereum"]
    previous = provider(NOW - 86400).get_prices(["ethereum"])["ethereum"].usd
    assert quote.change_24h == pytest.approx((quote.usd - previous) / previous * 100, abs=0.01)


def test_list_coins_sorted_by_market_cap():
    coins = provider().list_coins()
    caps = [c.market_cap for c in coins]
    assert len(coins) == len(MOCK_COINS) == 20
    assert caps == sorted(caps, reverse=True)
    assert coins[0].id == "bitcoin"


@pytest.mark.parametrize("days,expected", [(1, 288), (7, 168), (30, 180), (365, 365)])
def test_history_point_counts_and_order(days, expected):
    points = provider().get_history("bitcoin", days)
    assert expected <= len(points) <= expected + 2
    timestamps = [ts for ts, _ in points]
    assert timestamps == sorted(timestamps)
    assert timestamps[-1] == int(NOW * 1000)


def test_history_unknown_coin():
    with pytest.raises(UnknownCoinError):
        provider().get_history("not-a-coin", 7)


def test_history_rejects_unsupported_days():
    with pytest.raises(ValueError):
        provider().get_history("bitcoin", 2)
