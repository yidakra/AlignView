"""Print per-session counts from a user-study interaction log.

    python scripts/study_log_summary.py logs/session_2026-11-03.jsonl

One row per session code: asks (refinements included), answers, mean answer
latency, verdicts, refine sends and when the session was first and last seen.
Several log files can be passed; their lines are pooled.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from typing import Dict, List


def summarize(lines: List[str]) -> Dict[str, Dict[str, object]]:
    """Fold JSONL log lines into per-session counters (bad lines are skipped)."""
    out: Dict[str, Dict[str, object]] = defaultdict(
        lambda: {"asks": 0, "answers": 0, "latencies": [], "verdicts": 0,
                 "refine_sends": 0, "first": None, "last": None}
    )
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        s = out[str(rec.get("session"))]
        ts = rec.get("ts")
        s["first"] = s["first"] or ts
        s["last"] = ts or s["last"]
        event = rec.get("event")
        if event == "ask":
            s["asks"] += 1  # type: ignore[operator]
        elif event == "answer":
            s["answers"] += 1  # type: ignore[operator]
            if isinstance(rec.get("latency_ms"), (int, float)):
                s["latencies"].append(rec["latency_ms"])  # type: ignore[union-attr]
        elif event == "verdict":
            s["verdicts"] += 1  # type: ignore[operator]
        elif event == "refine_send":
            s["refine_sends"] += 1  # type: ignore[operator]
    return dict(out)


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("logs", nargs="+", help="JSONL study log file(s)")
    args = parser.parse_args(argv)
    lines: List[str] = []
    for path in args.logs:
        with open(path, encoding="utf-8") as fh:
            lines.extend(fh)
    rows = summarize(lines)
    print(f"{'session':8} {'asks':>5} {'answers':>7} {'mean_ms':>8} "
          f"{'verdicts':>8} {'refines':>7}  first -> last")
    for code, s in sorted(rows.items(), key=lambda kv: str(kv[1]["first"])):
        lat = s["latencies"]
        mean = f"{sum(lat) / len(lat):.0f}" if lat else "-"  # type: ignore[arg-type]
        print(f"{code:8} {s['asks']:>5} {s['answers']:>7} {mean:>8} "
              f"{s['verdicts']:>8} {s['refine_sends']:>7}  {s['first']} -> {s['last']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
