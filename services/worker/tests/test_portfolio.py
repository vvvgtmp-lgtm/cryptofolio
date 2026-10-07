from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from worker.portfolio import OversellError, Tx, compute_positions

T0 = datetime(2024, 1, 1, tzinfo=UTC)


def tx(coin, type_, qty, price, fee="0", minutes=0):
    return Tx(
        executed_at=T0 + timedelta(minutes=minutes),
        type=type_,
        coin_id=coin,
        quantity=Decimal(qty),
        price_usd=Decimal(price),
        fee_usd=Decimal(fee),
    )


def test_average_cost_includes_fees():
    p = compute_positions(
        [tx("bitcoin", "buy", "1", "100", "10", 0), tx("bitcoin", "buy", "1", "200", "0", 1)]
    )["bitcoin"]
    assert p.quantity == Decimal("2")
    assert p.cost_basis == Decimal("310")
    assert p.avg_cost == Decimal("155")


def test_sell_realises_pnl_at_average_cost():
    p = compute_positions(
        [tx("bitcoin", "buy", "2", "100", minutes=0), tx("bitcoin", "sell", "1", "150", "1", 1)]
    )["bitcoin"]
    assert p.realized_pnl == Decimal("49")
    assert p.quantity == Decimal("1")
    assert p.cost_basis == Decimal("100")


def test_oversell_raises():
    with pytest.raises(OversellError):
        compute_positions(
            [tx("bitcoin", "buy", "1", "1", minutes=0), tx("bitcoin", "sell", "2", "1", minutes=1)]
        )


def test_sell_before_buy_raises():
    with pytest.raises(OversellError):
        compute_positions(
            [tx("bitcoin", "buy", "1", "1", minutes=5), tx("bitcoin", "sell", "1", "1", minutes=0)]
        )


def test_buy_applied_before_sell_on_same_timestamp():
    compute_positions(
        [tx("bitcoin", "sell", "1", "1", minutes=3), tx("bitcoin", "buy", "1", "1", minutes=3)]
    )


def test_exact_decimals_close_position():
    p = compute_positions(
        [
            tx("eth", "buy", "0.1", "10", minutes=0),
            tx("eth", "buy", "0.2", "10", minutes=1),
            tx("eth", "sell", "0.3", "10", minutes=2),
        ]
    )["eth"]
    assert p.quantity == 0 and p.cost_basis == 0
    assert p.avg_cost == 0
