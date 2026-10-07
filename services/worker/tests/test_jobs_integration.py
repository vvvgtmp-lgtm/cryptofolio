from decimal import Decimal

import pytest

from tests.conftest import (
    add_tx,
    create_job,
    create_portfolio,
    create_user,
    integration,
    random_key,
)
from worker import jobs
from worker.jobs import PermanentJobError

pytestmark = integration

CSV = (
    "date,type,coin_id,quantity,price_usd,fee_usd,note\n"
    "2024-01-01T00:00:00Z,buy,bitcoin,1,40000,5,\n"
    "2024-02-01T00:00:00Z,sell,bitcoin,0.25,45000,0,take profit\n"
)


def upload(ctx, key, text):
    ctx.storage.put(ctx.storage.imports_bucket, key, text.encode(), "text/csv")


def tx_count(pool, portfolio_id):
    with pool.connection() as conn:
        return conn.execute(
            "SELECT count(*) AS n FROM transactions WHERE portfolio_id = %s", (portfolio_id,)
        ).fetchone()["n"]


def test_export_csv_writes_object_and_returns_filename(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user, "My Main!")
    add_tx(pool, portfolio, "bitcoin", "buy", "0.5", "42000")
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})
    outcome = jobs.export_csv(ctx, job)
    assert outcome.result_key == f"{user}/{job.id}.csv"
    assert outcome.result == {"filename": "my-main-transactions.csv", "rows": 1}
    body = ctx.storage.get(ctx.storage.exports_bucket, outcome.result_key).decode()
    assert "bitcoin,0.5,42000" in body


def test_import_csv_inserts_all_rows(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    key = random_key(user)
    upload(ctx, key, CSV)
    outcome = jobs.import_csv(
        ctx, create_job(pool, user, "import_csv", {"portfolioId": portfolio, "key": key})
    )
    assert outcome.result == {"imported": 2}
    assert tx_count(pool, portfolio) == 2


def test_import_rejects_oversell_and_inserts_nothing(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    key = random_key(user)
    upload(ctx, key, CSV.replace("sell,bitcoin,0.25", "sell,bitcoin,5"))
    with pytest.raises(PermanentJobError, match="cannot sell"):
        jobs.import_csv(
            ctx, create_job(pool, user, "import_csv", {"portfolioId": portfolio, "key": key})
        )
    assert tx_count(pool, portfolio) == 0


def test_import_rejects_unknown_coins(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    key = random_key(user)
    upload(ctx, key, CSV.replace("bitcoin", "notacoin"))
    with pytest.raises(PermanentJobError, match="notacoin"):
        jobs.import_csv(
            ctx, create_job(pool, user, "import_csv", {"portfolioId": portfolio, "key": key})
        )


def test_import_reports_csv_errors(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    key = random_key(user)
    upload(
        ctx, key, "date,type,coin_id,quantity,price_usd,fee_usd\n2024-01-01,buy,bitcoin,-1,1,0\n"
    )
    with pytest.raises(PermanentJobError, match="row 2"):
        jobs.import_csv(
            ctx, create_job(pool, user, "import_csv", {"portfolioId": portfolio, "key": key})
        )


def test_import_missing_file_and_foreign_key_and_foreign_portfolio(ctx, pool):
    alice = create_user(pool, "alice@example.com")
    bob = create_user(pool, "bob@example.com")
    alice_portfolio = create_portfolio(pool, alice)
    with pytest.raises(PermanentJobError, match="not found"):
        jobs.import_csv(
            ctx,
            create_job(
                pool,
                alice,
                "import_csv",
                {"portfolioId": alice_portfolio, "key": random_key(alice)},
            ),
        )
    with pytest.raises(PermanentJobError, match="invalid upload key"):
        jobs.import_csv(
            ctx,
            create_job(
                pool, alice, "import_csv", {"portfolioId": alice_portfolio, "key": random_key(bob)}
            ),
        )
    key = random_key(bob)
    upload(ctx, key, CSV)
    with pytest.raises(PermanentJobError, match="portfolio not found"):
        jobs.import_csv(
            ctx, create_job(pool, bob, "import_csv", {"portfolioId": alice_portfolio, "key": key})
        )


def test_report_pdf(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    add_tx(pool, portfolio, "bitcoin", "buy", "1", "40000")
    add_tx(pool, portfolio, "solana", "buy", "2", "100")  # no price in FakePrices
    job = create_job(pool, user, "report_pdf", {"portfolioId": portfolio})
    outcome = jobs.report_pdf(ctx, job)
    assert outcome.result_key == f"{user}/{job.id}.pdf"
    assert ctx.storage.get(ctx.storage.exports_bucket, outcome.result_key).startswith(b"%PDF")


def test_export_then_import_round_trips(ctx, pool):
    user = create_user(pool)
    source = create_portfolio(pool, user, "Source")
    target = create_portfolio(pool, user, "Target")
    add_tx(pool, source, "bitcoin", "buy", "0.123456789012345678", "42000.5")
    exported = jobs.export_csv(ctx, create_job(pool, user, "export_csv", {"portfolioId": source}))
    key = random_key(user)
    upload(ctx, key, ctx.storage.get(ctx.storage.exports_bucket, exported.result_key).decode())
    jobs.import_csv(ctx, create_job(pool, user, "import_csv", {"portfolioId": target, "key": key}))
    with pool.connection() as conn:
        qty = conn.execute(
            "SELECT quantity FROM transactions WHERE portfolio_id = %s", (target,)
        ).fetchone()["quantity"]
    assert qty == Decimal("0.123456789012345678")
