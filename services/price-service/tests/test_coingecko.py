import httpx
import pytest

from app.providers.base import ProviderError, Quote, UnknownCoinError
from app.providers.coingecko import CoinGeckoProvider


def make(handler) -> CoinGeckoProvider:
    return CoinGeckoProvider(
        "https://cg.test/api/v3", api_key="demo-key", transport=httpx.MockTransport(handler)
    )


def test_get_prices_parses_response_and_sends_api_key():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-cg-demo-api-key")
        return httpx.Response(200, json={"bitcoin": {"usd": 65000.5, "usd_24h_change": 1.234}})

    assert make(handler).get_prices(["bitcoin"]) == {"bitcoin": Quote(65000.5, 1.23)}
    assert seen["key"] == "demo-key"
    assert seen["url"].startswith("https://cg.test/api/v3/simple/price")
    assert "ids=bitcoin" in seen["url"]


def test_get_prices_with_no_ids_does_not_call_upstream():
    def handler(request):
        raise AssertionError("should not be called")

    assert make(handler).get_prices([]) == {}


def test_rate_limit_becomes_provider_error():
    with pytest.raises(ProviderError):
        make(lambda r: httpx.Response(429, json={"error": "rate limited"})).get_prices(["bitcoin"])


def test_network_error_becomes_provider_error():
    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(ProviderError):
        make(handler).list_coins()


def test_invalid_json_becomes_provider_error():
    with pytest.raises(ProviderError):
        make(lambda r: httpx.Response(200, text="<html>")).list_coins()


def test_history_404_is_unknown_coin():
    with pytest.raises(UnknownCoinError):
        make(lambda r: httpx.Response(404, json={"error": "coin not found"})).get_history("x", 7)


def test_history_parses_points():
    body = {"prices": [[1000, 1.5], [2000, 2.5]]}
    assert make(lambda r: httpx.Response(200, json=body)).get_history("bitcoin", 7) == [
        (1000, 1.5),
        (2000, 2.5),
    ]


def test_list_coins_tolerates_null_fields():
    body = [
        {
            "id": "newcoin",
            "symbol": "new",
            "name": "New Coin",
            "image": None,
            "current_price": None,
            "price_change_percentage_24h": None,
            "market_cap": None,
        }
    ]
    coin = make(lambda r: httpx.Response(200, json=body)).list_coins()[0]
    assert (coin.current_price, coin.change_24h, coin.market_cap) == (0.0, 0.0, 0.0)
