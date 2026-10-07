import httpx
import pytest

from worker.prices import PriceClient


def test_get_prices_chunks_by_100_and_maps_usd():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        ids = request.url.params["ids"].split(",")
        calls.append(len(ids))
        return httpx.Response(
            200, json={"prices": {i: {"usd": 1.5, "change_24h": 0} for i in ids}, "stale": False}
        )

    client = PriceClient("http://prices.test", transport=httpx.MockTransport(handler))
    prices = client.get_prices([f"c{i}" for i in range(150)] + ["c0"])
    assert calls == [100, 50]
    assert len(prices) == 150 and prices["c0"] == 1.5


def test_get_prices_empty_does_not_call():
    client = PriceClient(
        "http://prices.test", transport=httpx.MockTransport(lambda r: pytest.fail("called"))
    )
    assert client.get_prices([]) == {}


def test_errors_raise_http_error():
    client = PriceClient(
        "http://prices.test", transport=httpx.MockTransport(lambda r: httpx.Response(503))
    )
    with pytest.raises(httpx.HTTPError):
        client.get_prices(["bitcoin"])


def test_get_coins_indexes_by_id():
    body = {"coins": [{"id": "bitcoin", "symbol": "btc", "name": "Bitcoin"}], "stale": False}
    client = PriceClient(
        "http://prices.test",
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=body)),
    )
    assert client.get_coins()["bitcoin"]["symbol"] == "btc"
