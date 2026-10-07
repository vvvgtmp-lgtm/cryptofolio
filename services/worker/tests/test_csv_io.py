from datetime import UTC, datetime
from decimal import Decimal

import pytest

from worker.csv_io import CSV_HEADER, CsvImportError, build_transactions_csv, parse_transactions_csv
from worker.portfolio import Tx

HEADER = ",".join(CSV_HEADER)


def test_round_trip():
    txs = [
        Tx(
            datetime(2024, 1, 2, 3, 4, 5, tzinfo=UTC),
            "buy",
            "bitcoin",
            Decimal("0.500000000000000000"),
            Decimal("42000"),
            Decimal("10"),
            "first, buy",
        ),
        Tx(
            datetime(2024, 2, 1, tzinfo=UTC),
            "sell",
            "bitcoin",
            Decimal("0.1"),
            Decimal("50000.5"),
            Decimal("0"),
            None,
        ),
    ]
    text = build_transactions_csv(txs)
    assert text.splitlines()[0] == HEADER
    assert text.splitlines()[1] == '2024-01-02T03:04:05Z,buy,bitcoin,0.5,42000,10,"first, buy"'
    parsed = parse_transactions_csv(text)
    assert [
        (t.executed_at, t.type, t.coin_id, t.quantity, t.price_usd, t.fee_usd) for t in parsed
    ] == [(t.executed_at, t.type, t.coin_id, t.quantity, t.price_usd, t.fee_usd) for t in txs]


def test_naive_dates_are_utc_and_fee_defaults_to_zero():
    parsed = parse_transactions_csv(f"{HEADER}\n2024-03-01 10:00:00,BUY,Ethereum,2,3000,,\n")
    assert parsed[0].executed_at == datetime(2024, 3, 1, 10, tzinfo=UTC)
    assert parsed[0].type == "buy" and parsed[0].coin_id == "ethereum"
    assert parsed[0].fee_usd == 0


def test_accepts_bom_blank_lines_and_missing_note_column():
    header6 = ",".join(CSV_HEADER[:6])
    parsed = parse_transactions_csv(f"﻿{header6}\n\n2024-01-01,buy,bitcoin,1,1,0\n\n")
    assert len(parsed) == 1


def test_empty_file():
    with pytest.raises(CsvImportError, match="empty"):
        parse_transactions_csv("")


def test_header_only():
    with pytest.raises(CsvImportError, match="no transactions"):
        parse_transactions_csv(HEADER + "\n")


def test_wrong_header():
    with pytest.raises(CsvImportError, match="header"):
        parse_transactions_csv("when,what\n2024-01-01,buy\n")


def test_collects_row_errors_with_row_numbers():
    text = (
        f"{HEADER}\n"
        "2024-01-01,buy,bitcoin,0,100,0,\n"
        "2024-01-02,buy,bitcoin,1,100,0,\n"
        "yesterday,hold,,abc,-5,x,\n"
    )
    with pytest.raises(CsvImportError) as info:
        parse_transactions_csv(text)
    errors = info.value.errors
    assert len(errors) == 2
    assert errors[0].startswith("row 2:") and "quantity" in errors[0]
    assert errors[1].startswith("row 4:")
    for word in ("date", "type", "coin_id", "quantity", "price_usd", "fee_usd"):
        assert word in errors[1]


def test_rejects_nan_and_infinity():
    with pytest.raises(CsvImportError):
        parse_transactions_csv(f"{HEADER}\n2024-01-01,buy,bitcoin,NaN,Infinity,0,\n")


def test_too_many_rows():
    rows = "\n".join("2024-01-01,buy,bitcoin,1,1,0," for _ in range(5001))
    with pytest.raises(CsvImportError, match="5000"):
        parse_transactions_csv(f"{HEADER}\n{rows}\n")


def test_rejects_numbers_that_do_not_fit_the_database():
    text = (
        f"{HEADER}\n"
        "2024-01-01,buy,bitcoin,1e30,1,0,\n"
        "2024-01-01,buy,bitcoin,0.0000000000000000001,1,0,\n"
        "2024-01-01,buy,bitcoin,1,123456789012345678901,0,\n"
    )
    with pytest.raises(CsvImportError) as info:
        parse_transactions_csv(text)
    assert [e.split(":")[0] for e in info.value.errors] == ["row 2", "row 3", "row 4"]
    assert "out of range" in info.value.errors[0]


def test_rejects_future_dates_and_overlong_coin_ids():
    text = f"{HEADER}\n2999-01-01,buy,bitcoin,1,1,0,\n2024-01-01,buy,{'x' * 101},1,1,0,\n"
    with pytest.raises(CsvImportError) as info:
        parse_transactions_csv(text)
    assert "future" in info.value.errors[0] and "coin_id" in info.value.errors[1]
