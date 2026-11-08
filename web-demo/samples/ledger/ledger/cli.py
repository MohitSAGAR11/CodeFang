"""Command-line entry point."""

from __future__ import annotations

import argparse
import sys

from . import report, store


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ledger")
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add", help="record an expense")
    add.add_argument("amount", type=float)
    add.add_argument("category")
    add.add_argument("note", nargs="?", default="")

    rep = sub.add_parser("report", help="monthly totals")
    rep.add_argument("--month", default=store.today()[:7], help="YYYY-MM")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "add":
        entry = store.Entry(
            day=store.today(),
            amount=args.amount,
            category=args.category.lower(),
            note=args.note,
        )
        store.append(entry)
        print(f"added {entry.amount:.2f} to {entry.category}")
        return 0

    if args.command == "report":
        totals = report.monthly_totals(store.load(), args.month)
        print(report.format_report(totals))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
