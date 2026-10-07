from datetime import date
from decimal import Decimal

from tests.conftest import add_tx, create_portfolio, create_user, integration
from worker.scheduled import check_alerts, take_snapshots

pytestmark = integration


def add_alert(pool, user_id, coin, direction, target):
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO alerts (user_id, coin_id, direction, target_price) VALUES (%s, %s, %s, %s)",
            (user_id, coin, direction, Decimal(target)),
        )


def test_triggers_matching_alerts_once(ctx, pool):
    user = create_user(pool)
    add_alert(pool, user, "bitcoin", "above", "45000")  # 50000 >= 45000 -> trigger
    add_alert(pool, user, "bitcoin", "below", "45000")  # no
    add_alert(pool, user, "solana", "above", "1")  # no price -> skipped
    assert check_alerts(ctx) == 1
    assert check_alerts(ctx) == 0
    with pool.connection() as conn:
        notes = conn.execute(
            "SELECT title, body FROM notifications WHERE user_id = %s", (user,)
        ).fetchall()
        active = conn.execute("SELECT count(*) AS n FROM alerts WHERE active").fetchone()["n"]
    assert len(notes) == 1
    assert "bitcoin" in notes[0]["title"] and "$50,000.00" in notes[0]["body"]
    assert active == 2


def test_no_alerts_does_not_call_price_service(ctx, prices):
    prices.fail = True
    assert check_alerts(ctx) == 0


def test_snapshots_value_and_upsert(ctx, pool, prices):
    user = create_user(pool)
    main = create_portfolio(pool, user, "Main")
    empty = create_portfolio(pool, user, "Empty")
    partial = create_portfolio(pool, user, "Partial")
    add_tx(pool, main, "bitcoin", "buy", "2", "1")
    add_tx(pool, main, "bitcoin", "sell", "0.5", "1")
    add_tx(pool, main, "ethereum", "buy", "1", "1")
    add_tx(pool, partial, "solana", "buy", "1", "1")  # no price -> skipped
    today = date(2024, 5, 1)

    assert take_snapshots(ctx, today) == 2
    prices.prices["bitcoin"] = 60000.0
    take_snapshots(ctx, today)

    with pool.connection() as conn:
        rows = {
            r["portfolio_id"]: r["value_usd"]
            for r in conn.execute(
                "SELECT portfolio_id::text, value_usd FROM portfolio_snapshots WHERE date = %s",
                (today,),
            )
        }
    assert rows == {main: Decimal("93000.00"), empty: Decimal("0.00")}
