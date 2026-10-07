import fakeredis
import pytest
from fastapi.testclient import TestClient

from app.cache import PriceService
from app.config import Settings
from app.main import build_service, create_app
from app.providers.base import ProviderError
from app.providers.mock import MockProvider

NOW = 1_760_000_000.0


class DownProvider:
    def list_coins(self):
        raise ProviderError("down")

    def get_prices(self, ids):
        raise ProviderError("down")

    def get_history(self, coin_id, days):
        raise ProviderError("down")


def client_for(provider) -> TestClient:
    redis = fakeredis.FakeRedis(decode_responses=True)
    service = PriceService(provider, redis)
    return TestClient(create_app(settings=Settings(), redis=redis, service=service))


@pytest.fixture
def client() -> TestClient:
    return client_for(MockProvider(clock=lambda: NOW))


def test_health_and_ready(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").status_code == 200


def test_metrics_exposed(client):
    client.get("/coins")
    body = client.get("/metrics").text
    assert "http_request_duration_seconds" in body
    assert "price_cache_events_total" in body


def test_coins(client):
    body = client.get("/coins").json()
    assert len(body["coins"]) == 20
    assert set(body["coins"][0]) == {
        "id",
        "symbol",
        "name",
        "image",
        "current_price",
        "change_24h",
        "market_cap",
    }
    assert body["stale"] is False


def test_prices(client):
    body = client.get("/prices", params={"ids": "bitcoin,ethereum,nope"}).json()
    assert set(body["prices"]) == {"bitcoin", "ethereum"}
    assert set(body["prices"]["bitcoin"]) == {"usd", "change_24h"}


def test_prices_requires_ids(client):
    assert client.get("/prices", params={"ids": ","}).status_code == 400
    assert client.get("/prices").status_code == 422


def test_prices_rejects_more_than_100_ids(client):
    ids = ",".join(f"c{i}" for i in range(101))
    assert client.get("/prices", params={"ids": ids}).status_code == 400


def test_history(client):
    body = client.get("/history/bitcoin", params={"days": 7}).json()
    assert body["id"] == "bitcoin" and body["days"] == 7 and len(body["points"]) >= 168


def test_history_rejects_bad_days(client):
    assert client.get("/history/bitcoin", params={"days": 2}).status_code == 400


def test_history_unknown_coin(client):
    assert client.get("/history/not-a-coin").status_code == 404


def test_provider_down_with_empty_cache_is_503():
    response = client_for(DownProvider()).get("/prices", params={"ids": "bitcoin"})
    assert response.status_code == 503
    assert response.json() == {"detail": "price provider unavailable"}


def test_binance_provider_is_selectable_and_cache_is_namespaced():
    from app.providers.binance import BinanceProvider

    service = build_service(
        Settings(price_provider="binance"), fakeredis.FakeRedis(decode_responses=True)
    )
    assert isinstance(service._provider, BinanceProvider)
    assert service._ns == "binance:"
