"""Monthly totals by category."""

from __future__ import annotations

from collections import defaultdict

from .store import Entry


def monthly_totals(entries: list[Entry], month: str) -> dict[str, float]:
    """Sum amounts per category for entries whose day starts with `month` (YYYY-MM)."""
    totals: dict[str, float] = defaultdict(float)
    for e in entries:
        if e.day.startswith(month):
            totals[e.category] += e.amount
    return dict(sorted(totals.items()))


def format_report(totals: dict[str, float]) -> str:
    if not totals:
        return "no entries"
    width = max(len(c) for c in [*totals, "total"]) + 2
    lines = [f"{cat:<{width}}{amount:>8.2f}" for cat, amount in totals.items()]
    lines.append(f"{'total':<{width}}{sum(totals.values()):>8.2f}")
    return "\n".join(lines)
