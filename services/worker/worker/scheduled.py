import logging
from datetime import UTC, date, datetime
from decimal import Decimal

from psycopg.rows import dict_row

from .jobs import Ctx
from .metrics import ALERTS_TRIGGERED, SNAPSHOTS_WRITTEN

log = logging.getLogger("worker.scheduled")
CENT = Decimal("0.01")


def evaluate_alert(direction: str, target: Decimal, price: float) -> bool:
    current = Decimal(str(price))
    return current >= target if direction == "above" else current <= target


def check_alerts(ctx: Ctx) -> int:
    with ctx.pool.connection() as conn:
        alerts = conn.execute(
            "SELECT id, user_id, coin_id, direction, target_price FROM alerts WHERE active"
        ).fetchall()
    if not alerts:
        return 0

    prices = ctx.prices.get_prices(sorted({a["coin_id"] for a in alerts}))
    triggered = 0
    for alert in alerts:
        price = prices.get(alert["coin_id"])
        if price is None or not evaluate_alert(alert["direction"], alert["target_price"], price):
            continue
        with ctx.pool.connection() as conn, conn.transaction():
            claimed = conn.execute(
                "UPDATE alerts SET active = false, triggered_at = now() "
                "WHERE id = %s AND active RETURNING id",
                (alert["id"],),
            ).fetchone()
            if claimed is None:  # another worker got there first
                continue
            target = alert["target_price"]
            conn.execute(
                "INSERT INTO notifications (user_id, title, body) VALUES (%s, %s, %s)",
                (
                    alert["user_id"],
                    f"{alert['coin_id']} is {alert['direction']} ${target:,.2f}",
                    f"Current price ${price:,.2f} crossed your {alert['direction']} "
                    f"${target:,.2f} alert.",
                ),
            )
        triggered += 1
    ALERTS_TRIGGERED.inc(triggered)
    return triggered


def take_snapshots(ctx: Ctx, today: date | None = None) -> int:
    today = today or datetime.now(UTC).date()
    with ctx.pool.connection() as conn:
        rows = conn.execute(
            "SELECT p.id::text AS portfolio_id, t.coin_id, "
            "SUM(CASE WHEN t.type = 'buy' THEN t.quantity ELSE -t.quantity END) AS quantity "
            "FROM portfolios p LEFT JOIN transactions t ON t.portfolio_id = p.id "
            "GROUP BY p.id, t.coin_id"
        ).fetchall()

    holdings: dict[str, dict[str, Decimal]] = {}
    for row in rows:
        coins_held = holdings.setdefault(row["portfolio_id"], {})  # empty portfolios too
        if row["coin_id"] and row["quantity"] > 0:
            coins_held[row["coin_id"]] = row["quantity"]

    coins = sorted({coin for coins in holdings.values() for coin in coins})
    prices = ctx.prices.get_prices(coins) if coins else {}

    values = []
    for portfolio_id, coins_held in holdings.items():
        missing = [c for c in coins_held if c not in prices]
        if missing:
            log.warning(
                "skipping snapshot, missing prices for %s", missing, extra={"task": "snapshots"}
            )
            continue
        total = sum((qty * Decimal(str(prices[c])) for c, qty in coins_held.items()), Decimal(0))
        values.append((portfolio_id, today, total.quantize(CENT)))

    with ctx.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.executemany(
            "INSERT INTO portfolio_snapshots (portfolio_id, date, value_usd) VALUES (%s, %s, %s) "
            "ON CONFLICT (portfolio_id, date) DO UPDATE SET value_usd = EXCLUDED.value_usd",
            values,
        )
    SNAPSHOTS_WRITTEN.inc(len(values))
    return len(values)
