# Market census

Counts how many of Gemini's live production prediction markets contain linked
contracts that support a two-order conditional bet, and what those bets cost
relative to fair value. Read-only: it uses the public events API, no API key,
and places no orders.

```bash
python3 -I tools/census/census.py fetch     # download the active events into census_data/ (about 60 MB, git-ignored)
python3 -I tools/census/census.py explore   # list the strike types found, with examples
python3 -I tools/census/census.py report    # print the full analysis
```

Prices move, so re-run it before quoting any number.

Result on 2026-11-17: 1,003 active top-level events (1,449 including nested
sports markets) and 18,414 contracts. Nested ladders gave about 6,900 tradable
pairs across 169 events, almost all sports totals and spreads; strict
"or above" ladders (crypto and commodities) gave 337 pairs across 15 events.
The script's classification of "likely exclusive" outcome lists and its
cross-event sports matching are heuristics, not ground truth.
