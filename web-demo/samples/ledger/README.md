# ledger

A pocket expense tracker for the terminal.

```console
$ ledger add 12.50 food "ramen"
$ ledger add 3.10 transport
$ ledger report --month 2026-11
food        12.50
transport    3.10
total       15.60
```

Entries live in `~/.ledger.json`.

## Development

```console
$ python -m pytest
```
