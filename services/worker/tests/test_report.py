from datetime import UTC, datetime
from decimal import Decimal

from worker.report import ReportRow, build_portfolio_report


def test_builds_a_pdf():
    rows = [
        ReportRow("bitcoin", Decimal("0.5"), Decimal("42000"), 50000.0, 25000.0, 4000.0),
        ReportRow("solana", Decimal("3"), Decimal("100"), None, None, None),
    ]
    pdf = build_portfolio_report(
        "Main <&> Co", "Alice", rows, Decimal("12.5"), datetime(2024, 1, 1, tzinfo=UTC)
    )
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 1000


def test_builds_a_pdf_for_an_empty_portfolio():
    assert build_portfolio_report("Empty", "Bob", [], Decimal(0), datetime.now(UTC)).startswith(
        b"%PDF"
    )
