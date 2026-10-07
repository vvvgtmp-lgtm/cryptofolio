"""Average-cost position math (mirrors services/api/src/lib/holdings.ts)."""

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

ZERO = Decimal(0)


@dataclass(frozen=True)
class Tx:
    executed_at: datetime
    type: str
    coin_id: str
    quantity: Decimal
    price_usd: Decimal
    fee_usd: Decimal
    note: str | None = None


@dataclass
class Position:
    coin_id: str
    quantity: Decimal = field(default=ZERO)
    cost_basis: Decimal = field(default=ZERO)
    realized_pnl: Decimal = field(default=ZERO)

    @property
    def avg_cost(self) -> Decimal:
        return self.cost_basis / self.quantity if self.quantity > 0 else ZERO


class OversellError(ValueError):
    pass


def compute_positions(txs: Iterable[Tx]) -> dict[str, Position]:
    ordered = sorted(txs, key=lambda t: (t.executed_at, 0 if t.type == "buy" else 1))
    positions: dict[str, Position] = {}
    for t in ordered:
        p = positions.setdefault(t.coin_id, Position(t.coin_id))
        if t.type == "buy":
            p.quantity += t.quantity
            p.cost_basis += t.quantity * t.price_usd + t.fee_usd
            continue
        if t.quantity > p.quantity:
            raise OversellError(
                f"cannot sell {t.quantity} {t.coin_id} on {t.executed_at:%Y-%m-%d}: "
                f"only {p.quantity} held"
            )
        cost_removed = p.cost_basis / p.quantity * t.quantity
        p.realized_pnl += t.quantity * t.price_usd - t.fee_usd - cost_removed
        p.quantity -= t.quantity
        p.cost_basis = ZERO if p.quantity == 0 else p.cost_basis - cost_removed
    return positions
