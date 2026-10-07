"""Background job handlers. Each takes (Ctx, Job) and returns a JobOutcome.

Raise PermanentJobError for bad input (never retried). Any other exception is
treated as transient and retried by the consumer.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from botocore.exceptions import ClientError
from psycopg_pool import ConnectionPool

from .config import Settings
from .csv_io import CsvImportError, build_transactions_csv, parse_transactions_csv
from .portfolio import OversellError, Tx, compute_positions
from .prices import PriceClient
from .report import ReportRow, build_portfolio_report
from .storage import Storage


@dataclass
class Job:
    id: str
    user_id: str
    type: str
    params: dict[str, Any]
    attempts: int


@dataclass
class JobOutcome:
    result_key: str | None = None
    result: dict[str, Any] | None = None


@dataclass
class Ctx:
    pool: ConnectionPool
    storage: Storage
    prices: PriceClient
    settings: Settings


class PermanentJobError(Exception):
    """The job can never succeed (bad input); do not retry."""


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "portfolio"


def _owned_portfolio(conn, job: Job) -> dict:
    row = conn.execute(
        "SELECT id, name FROM portfolios WHERE id = %s AND user_id = %s",
        (job.params.get("portfolioId"), job.user_id),
    ).fetchone()
    if row is None:
        raise PermanentJobError("portfolio not found")
    return row


def _load_txs(conn, portfolio_id) -> list[Tx]:
    rows = conn.execute(
        "SELECT executed_at, type, coin_id, quantity, price_usd, fee_usd, note FROM transactions "
        "WHERE portfolio_id = %s ORDER BY executed_at, created_at",
        (portfolio_id,),
    ).fetchall()
    return [Tx(**row) for row in rows]


def export_csv(ctx: Ctx, job: Job) -> JobOutcome:
    with ctx.pool.connection() as conn:
        portfolio = _owned_portfolio(conn, job)
        txs = _load_txs(conn, portfolio["id"])
    key = f"{job.user_id}/{job.id}.csv"
    ctx.storage.put(
        ctx.storage.exports_bucket, key, build_transactions_csv(txs).encode(), "text/csv"
    )
    return JobOutcome(
        result_key=key,
        result={"filename": f"{_slug(portfolio['name'])}-transactions.csv", "rows": len(txs)},
    )


def import_csv(ctx: Ctx, job: Job) -> JobOutcome:
    key = str(job.params.get("key", ""))
    if not key.startswith(f"{job.user_id}/"):
        raise PermanentJobError("invalid upload key")
    try:
        raw = ctx.storage.get(ctx.storage.imports_bucket, key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            raise PermanentJobError("uploaded file not found") from exc
        raise
    try:
        parsed = parse_transactions_csv(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise PermanentJobError("file must be a UTF-8 encoded CSV") from exc
    except CsvImportError as exc:
        raise PermanentJobError(str(exc)) from exc

    known = ctx.prices.get_coins()
    unknown = sorted({t.coin_id for t in parsed} - set(known))
    if unknown:
        raise PermanentJobError(f"unknown coin ids: {', '.join(unknown)}")

    with ctx.pool.connection() as conn, conn.transaction():
        portfolio = _owned_portfolio(conn, job)
        # Serialise imports/edits into the same portfolio while we validate.
        conn.execute("SELECT id FROM portfolios WHERE id = %s FOR UPDATE", (portfolio["id"],))
        try:
            compute_positions(_load_txs(conn, portfolio["id"]) + parsed)
        except OversellError as exc:
            raise PermanentJobError(str(exc)) from exc
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO transactions "
                "(portfolio_id, coin_id, type, quantity, price_usd, fee_usd, executed_at, note) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    (
                        portfolio["id"],
                        t.coin_id,
                        t.type,
                        t.quantity,
                        t.price_usd,
                        t.fee_usd,
                        t.executed_at,
                        t.note,
                    )
                    for t in parsed
                ],
            )
    return JobOutcome(result={"imported": len(parsed)})


def report_pdf(ctx: Ctx, job: Job) -> JobOutcome:
    with ctx.pool.connection() as conn:
        portfolio = _owned_portfolio(conn, job)
        txs = _load_txs(conn, portfolio["id"])
        owner = conn.execute(
            "SELECT display_name FROM users WHERE id = %s", (job.user_id,)
        ).fetchone()["display_name"]

    positions = compute_positions(txs)
    open_positions = [p for p in positions.values() if p.quantity > 0]
    prices = ctx.prices.get_prices([p.coin_id for p in open_positions])
    rows = []
    for p in sorted(open_positions, key=lambda p: p.coin_id):
        price = prices.get(p.coin_id)
        value = float(p.quantity) * price if price is not None else None
        rows.append(
            ReportRow(
                coin_id=p.coin_id,
                quantity=p.quantity,
                avg_cost=p.avg_cost,
                price=price,
                value=value,
                pnl=value - float(p.cost_basis) if value is not None else None,
            )
        )
    realized = sum((p.realized_pnl for p in positions.values()), Decimal(0))
    pdf = build_portfolio_report(portfolio["name"], owner, rows, realized, datetime.now(UTC))

    key = f"{job.user_id}/{job.id}.pdf"
    ctx.storage.put(ctx.storage.exports_bucket, key, pdf, "application/pdf")
    return JobOutcome(result_key=key, result={"filename": f"{_slug(portfolio['name'])}-report.pdf"})


HANDLERS: dict[str, Callable[[Ctx, Job], JobOutcome]] = {
    "export_csv": export_csv,
    "import_csv": import_csv,
    "report_pdf": report_pdf,
}
