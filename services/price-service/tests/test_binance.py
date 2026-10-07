import json

import httpx
import pytest

from app.providers.base import ProviderError, Quote, UnknownCoinError
from app.providers.binance import BinanceProvider
from app.providers.catalogue import CATALOGUE

SUPPLY = {c[0]: c[4] for c in CATALOGUE}


def ticker(symbol: str, price: float, change: float) -> dict:
    return {"symbol": symbol, "lastPrice": f"{price:.8f}", "priceChangePercent": f"{change:.3f}"}


def make(handler) -> BinanceProvider:
    return BinanceProvider("https://binance.test", transport=httpx.MockTransport(handler))


def requested_symbols(request: httpx.Request) -> list[str]:
    return json.loads(request.url.params["symbols"])


def echo_tickers(price: float = 10.0, change: float = 1.234):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = [ticker(s, price, change) for s in requested_symbols(request)]
        return httpx.Response(200, json=body)

    return handler, seen


def test_list_coins_covers_the_catalogue_in_one_call():
    handler, seen = echo_tickers()
    coins = make(handler).list_coins()
    assert len(seen) == 1 and seen[0].url.path == "/api/v3/ticker/24hr"
    symbols = requested_symbols(seen[0])
    assert "LINKUSDT" in symbols and "BTCUSDT" in symbols
    assert "USDTUSDT" not in symbols  # tether is the quote currency
    assert {c.id for c in coins} == {c[0] for c in CATALOGUE}


def test_list_coins_market_cap_from_supply_and_sorted():
    def handler(request):
        prices = {"BTCUSDT": 80000.0, "LINKUSDT": 13.77}
        return httpx.Response(
            200, json=[ticker(s, prices.get(s, 1.0), 0.5) for s in requested_symbols(request)]
        )

    coins = make(handler).list_coins()
    link = next(c for c in coins if c.id == "chainlink")
    assert link.current_price == 13.77 and link.symbol == "link" and link.name == "Chainlink"
    assert link.market_cap == round(13.77 * SUPPLY["chainlink"])
    assert link.image is None
    caps = [c.market_cap for c in coins]
    assert caps == sorted(caps, reverse=True) and coins[0].id == "bitcoin"


def test_tether_is_fixed_at_one_dollar():
    handler, _ = echo_tickers(price=123.0)
    tether = next(c for c in make(handler).list_coins() if c.id == "tether")
    assert (tether.current_price, tether.change_24h) == (1.0, 0.0)
    assert make(handler).get_prices(["tether"]) == {"tether": Quote(1.0, 0.0)}


def test_get_prices_requests_only_known_ids_and_rounds_change():
    handler, seen = echo_tickers(price=13.77, change=-3.768)
    quotes = make(handler).get_prices(["chainlink", "not-a-coin"])
    assert quotes == {"chainlink": Quote(13.77, -3.77)}
    assert requested_symbols(seen[0]) == ["LINKUSDT"]


def test_get_prices_without_known_ids_does_not_call_upstream():
    def handler(request):
        raise AssertionError("should not be called")

    assert make(handler).get_prices(["not-a-coin"]) == {}
    assert make(handler).get_prices(["tether"]) == {"tether": Quote(1.0, 0.0)}


@pytest.mark.parametrize(
    "days,interval,limit", [(1, "5m", 289), (7, "1h", 169), (30, "4h", 181), (365, "1d", 366)]
)
def test_history_uses_matching_candles(days, interval, limit):
    seen = {}

    def handler(request):
        seen.update(request.url.params)
        seen["path"] = request.url.path
        return httpx.Response(
            200, json=[[1000, "1", "2", "0.5", "1.5", "9"], [2000, "1.5", "2", "1", "1.75", "9"]]
        )

    points = make(handler).get_history("chainlink", days)
    assert seen["path"] == "/api/v3/klines"
    assert (seen["symbol"], seen["interval"], seen["limit"]) == ("LINKUSDT", interval, str(limit))
    assert points == [(1000, 1.5), (2000, 1.75)]


def test_history_for_tether_is_flat_without_upstream_call():
    def handler(request):
        raise AssertionError("should not be called")

    points = make(handler).get_history("tether", 7)
    assert len(points) >= 168 and {p for _, p in points} == {1.0}


def test_history_unknown_coin_and_bad_days():
    handler, _ = echo_tickers()
    with pytest.raises(UnknownCoinError):
        make(handler).get_history("not-a-coin", 7)
    with pytest.raises(ValueError):
        make(handler).get_history("bitcoin", 2)


@pytest.mark.parametrize("status", [400, 418, 429, 500])
def test_http_errors_become_provider_errors(status):
    with pytest.raises(ProviderError):
        make(lambda r: httpx.Response(status, json={"code": -1, "msg": "nope"})).get_prices(
            ["bitcoin"]
        )


def test_network_errors_and_bad_json_become_provider_errors():
    def boom(request):
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(ProviderError):
        make(boom).list_coins()
    with pytest.raises(ProviderError):
        make(lambda r: httpx.Response(200, text="<html>")).list_coins()
