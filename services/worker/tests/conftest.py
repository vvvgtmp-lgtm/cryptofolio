import os
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
from psycopg.types.json import Jsonb
from redis import Redis

from worker.config import Settings
from worker.db import make_pool
from worker.jobs import Ctx, Job
from worker.storage import Storage

integration = pytest.mark.skipif(
    os.getenv("INTEGRATION") != "1", reason="set INTEGRATION=1 and start docker-compose.test.yml"
)


class FakePrices:
    def __init__(self):
        self.prices = {"bitcoin": 50000.0, "ethereum": 3000.0}
        self.fail = False

    def get_prices(self, ids):
        if self.fail:
            raise httpx.ConnectError("price-service down")
        return {i: self.prices[i] for i in ids if i in self.prices}

    def get_coins(self):
        return {i: {"id": i, "symbol": i[:3], "name": i.title()} for i in self.prices}


@pytest.fixture
def settings() -> Settings:
    return Settings(
        database_url=os.getenv(
            "DATABASE_URL", "postgres://cryptofolio:cryptofolio@localhost:55432/cryptofolio_test"
        ),
        redis_url=os.getenv("REDIS_URL", "redis://localhost:56379/1"),
        s3_endpoint=os.getenv("S3_ENDPOINT", "http://localhost:59000"),
        jobs_stream="jobs-worker-test",
        jobs_group="workers-test",
    )


@pytest.fixture
def pool(settings):
    p = make_pool(settings.database_url)
    with p.connection() as conn:
        conn.execute(
            "TRUNCATE users, portfolios, transactions, watchlist, alerts, notifications, "
            "portfolio_snapshots, jobs CASCADE"
        )
    yield p
    p.close()


@pytest.fixture
def redis(settings):
    r = Redis.from_url(settings.redis_url, decode_responses=True)
    r.flushdb()
    yield r
    r.close()


@pytest.fixture
def prices() -> FakePrices:
    return FakePrices()


@pytest.fixture
def ctx(pool, settings, prices) -> Ctx:
    return Ctx(pool=pool, storage=Storage(settings), prices=prices, settings=settings)


def create_user(pool, email="alice@example.com") -> str:
    with pool.connection() as conn:
        return str(
            conn.execute(
                "INSERT INTO users (email, password_hash, display_name) VALUES (%s, 'x', 'Alice') RETURNING id",
                (email,),
            ).fetchone()["id"]
        )


def create_portfolio(pool, user_id, name="Main") -> str:
    with pool.connection() as conn:
        return str(
            conn.execute(
                "INSERT INTO portfolios (user_id, name) VALUES (%s, %s) RETURNING id",
                (user_id, name),
            ).fetchone()["id"]
        )


def add_tx(pool, portfolio_id, coin, type_, qty, price, when=datetime(2024, 1, 1, tzinfo=UTC)):
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO transactions (portfolio_id, coin_id, type, quantity, price_usd, executed_at) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (portfolio_id, coin, type_, Decimal(qty), Decimal(price), when),
        )


def create_job(pool, user_id, type_, params, status="queued") -> Job:
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO jobs (user_id, type, params, status) VALUES (%s, %s, %s, %s) RETURNING id",
            (user_id, type_, Jsonb(params), status),
        ).fetchone()
    return Job(id=str(row["id"]), user_id=user_id, type=type_, params=params, attempts=1)


def get_job(pool, job_id) -> dict:
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM jobs WHERE id = %s", (job_id,)).fetchone()


def random_key(user_id: str) -> str:
    return f"{user_id}/{uuid.uuid4()}.csv"
