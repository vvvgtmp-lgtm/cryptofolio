import io
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


@dataclass(frozen=True)
class ReportRow:
    coin_id: str
    quantity: Decimal
    avg_cost: Decimal
    price: float | None
    value: float | None
    pnl: float | None


def _usd(value: float | Decimal | None) -> str:
    return "n/a" if value is None else f"${value:,.2f}"


def build_portfolio_report(
    portfolio_name: str,
    owner: str,
    rows: list[ReportRow],
    realized_pnl: Decimal,
    generated_at: datetime,
) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, title=f"{portfolio_name} - CryptoFolio report")
    styles = getSampleStyleSheet()

    table_data = [["Coin", "Quantity", "Avg cost", "Price", "Value", "Unrealized P/L"]]
    for r in rows:
        table_data.append(
            [
                r.coin_id,
                f"{r.quantity.normalize():f}",
                _usd(r.avg_cost),
                _usd(r.price),
                _usd(r.value),
                _usd(r.pnl),
            ]
        )
    total_value = sum(r.value for r in rows if r.value is not None)
    total_pnl = sum(r.pnl for r in rows if r.pnl is not None)
    table_data.append(["Total", "", "", "", _usd(total_value), _usd(total_pnl)])

    table = Table(table_data, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#f1f5f9")]),
            ]
        )
    )

    story = [
        Paragraph(f"CryptoFolio &mdash; {escape(portfolio_name)}", styles["Title"]),
        Paragraph(
            f"Prepared for {escape(owner)} on {generated_at:%Y-%m-%d %H:%M} UTC", styles["Normal"]
        ),
        Spacer(1, 16),
        table,
        Spacer(1, 16),
        Paragraph(f"Realized P/L to date: {_usd(realized_pnl)}", styles["Normal"]),
        Paragraph(
            "Average-cost method. Prices from the CryptoFolio price-service.", styles["Italic"]
        ),
    ]
    doc.build(story)
    return buffer.getvalue()
