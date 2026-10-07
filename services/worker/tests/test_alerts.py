from decimal import Decimal

import pytest

from worker.scheduled import evaluate_alert


@pytest.mark.parametrize(
    "direction,target,price,expected",
    [
        ("above", "100", 100.0, True),
        ("above", "100", 99.99, False),
        ("below", "100", 100.0, True),
        ("below", "100", 100.01, False),
        ("above", "0.0000001", 0.0000002, True),
    ],
)
def test_evaluate_alert(direction, target, price, expected):
    assert evaluate_alert(direction, Decimal(target), price) is expected
