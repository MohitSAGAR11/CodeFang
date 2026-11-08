"""Persistence: a single JSON file of entries."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

DEFAULT_PATH = Path.home() / ".ledger.json"


@dataclass(frozen=True)
class Entry:
    day: str  # ISO date, e.g. "2026-11-08"
    amount: float
    category: str
    note: str = ""


def load(path: Path = DEFAULT_PATH) -> list[Entry]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    return [Entry(**item) for item in raw]


def save(entries: list[Entry], path: Path = DEFAULT_PATH) -> None:
    path.write_text(
        json.dumps([asdict(e) for e in entries], indent=2),
        encoding="utf-8",
    )


def append(entry: Entry, path: Path = DEFAULT_PATH) -> list[Entry]:
    entries = [*load(path), entry]
    save(entries, path)
    return entries


def today() -> str:
    return date.today().isoformat()
