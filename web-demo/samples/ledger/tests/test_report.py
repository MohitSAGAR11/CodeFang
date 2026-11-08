from ledger.report import format_report, monthly_totals
from ledger.store import Entry


def test_totals_group_by_category():
    entries = [
        Entry("2026-11-01", 0.10, "food"),
        Entry("2026-11-02", 0.20, "food"),
        Entry("2026-10-30", 5.00, "food"),
    ]
    assert monthly_totals(entries, "2026-11") == {"food": 0.30000000000000004}


def test_empty_report():
    assert format_report({}) == "no entries"
