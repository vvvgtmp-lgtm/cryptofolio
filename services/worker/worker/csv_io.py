"""Transaction CSV format shared by export and import (round-trips exactly)."""

import csv
import io
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation

from .portfolio import Tx

CSV_HEADER = ["date", "type", "coin_id", "quantity", "price_usd", "fee_usd", "note"]
REQUIRED_COLUMNS = CSV_HEADER[:6]
MAX_ROWS = 5000
MAX_ERRORS_SHOWN = 10
# Same limits as the api (numeric(38,18) columns): 20 integer digits, 18 decimals.
MAX_ABS = Decimal(10) ** 20
MAX_SCALE = 18
MAX_COIN_ID = 100
FUTURE_TOLERANCE = timedelta(minutes=5)


class CsvImportError(ValueError):
    def __init__(self, errors: list[str]):
        self.errors = errors
        shown = "; ".join(errors[:MAX_ERRORS_SHOWN])
        more = len(errors) - MAX_ERRORS_SHOWN
        super().__init__(shown + (f" (+{more} more)" if more > 0 else ""))


def _fmt(value: Decimal) -> str:
    return format(value.normalize(), "f") if value != 0 else "0"


def build_transactions_csv(txs: list[Tx]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(CSV_HEADER)
    for t in txs:
        date = t.executed_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
        writer.writerow(
            [
                date,
                t.type,
                t.coin_id,
                _fmt(t.quantity),
                _fmt(t.price_usd),
                _fmt(t.fee_usd),
                t.note or "",
            ]
        )
    return buffer.getvalue()


def _decimal(raw: str) -> Decimal | None:
    try:
        value = Decimal(raw)
    except InvalidOperation:
        return None
    return value if value.is_finite() else None


def _fits(value: Decimal) -> bool:
    return abs(value) < MAX_ABS and value.normalize().as_tuple().exponent >= -MAX_SCALE


def _parse_date(raw: str) -> datetime | None:
    try:
        value = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def parse_transactions_csv(text: str) -> list[Tx]:
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    if not rows:
        raise CsvImportError(["file is empty"])
    header = [h.strip().lower() for h in rows[0]]
    if header[: len(REQUIRED_COLUMNS)] != REQUIRED_COLUMNS:
        raise CsvImportError([f"header must be: {','.join(CSV_HEADER)}"])

    numbered = [(n, r) for n, r in enumerate(rows[1:], start=2) if any(c.strip() for c in r)]
    if not numbered:
        raise CsvImportError(["file has no transactions"])
    if len(numbered) > MAX_ROWS:
        raise CsvImportError([f"file has {len(numbered)} rows, the limit is {MAX_ROWS}"])

    txs: list[Tx] = []
    errors: list[str] = []
    for line_no, row in numbered:
        cells = [c.strip() for c in row] + [""] * (len(CSV_HEADER) - len(row))
        date_raw, type_raw, coin_raw, qty_raw, price_raw, fee_raw, note = cells[: len(CSV_HEADER)]
        problems = []

        executed_at = _parse_date(date_raw)
        if executed_at is None:
            problems.append("date must be ISO 8601 (e.g. 2024-01-31T12:00:00Z)")
        elif executed_at > datetime.now(UTC) + FUTURE_TOLERANCE:
            problems.append("date cannot be in the future")
        tx_type = type_raw.lower()
        if tx_type not in ("buy", "sell"):
            problems.append("type must be buy or sell")
        coin_id = coin_raw.lower()
        if not coin_id:
            problems.append("coin_id is required")
        elif len(coin_id) > MAX_COIN_ID:
            problems.append(f"coin_id must be at most {MAX_COIN_ID} characters")
        quantity = _decimal(qty_raw)
        if quantity is None or quantity <= 0:
            problems.append("quantity must be a positive number")
        price = _decimal(price_raw)
        if price is None or price < 0:
            problems.append("price_usd must be a non-negative number")
        fee = _decimal(fee_raw or "0")
        if fee is None or fee < 0:
            problems.append("fee_usd must be a non-negative number")
        for label, value in (("quantity", quantity), ("price_usd", price), ("fee_usd", fee)):
            if value is not None and not _fits(value):
                problems.append(
                    f"{label} out of range (max 20 digits before and 18 after the decimal point)"
                )
        if len(note) > 200:
            problems.append("note must be at most 200 characters")

        if problems:
            errors.append(f"row {line_no}: {', '.join(problems)}")
            continue
        txs.append(Tx(executed_at, tx_type, coin_id, quantity, price, fee, note or None))

    if errors:
        raise CsvImportError(errors)
    return txs
