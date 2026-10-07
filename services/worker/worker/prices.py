import httpx

CHUNK = 100


class PriceClient:
    """Thin client for the internal price-service."""

    def __init__(
        self, base_url: str, timeout: float = 5.0, transport: httpx.BaseTransport | None = None
    ):
        self._client = httpx.Client(base_url=base_url, timeout=timeout, transport=transport)

    def get_prices(self, ids: list[str]) -> dict[str, float]:
        unique = sorted(set(ids))
        prices: dict[str, float] = {}
        for i in range(0, len(unique), CHUNK):
            response = self._client.get("/prices", params={"ids": ",".join(unique[i : i + CHUNK])})
            response.raise_for_status()
            prices.update({k: float(v["usd"]) for k, v in response.json()["prices"].items()})
        return prices

    def get_coins(self) -> dict[str, dict]:
        response = self._client.get("/coins")
        response.raise_for_status()
        return {c["id"]: c for c in response.json()["coins"]}
