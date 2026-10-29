"""Opt-in interaction log for user-study sessions.

Set ``CASTLERAG_STUDY_LOG`` to a file path and the dashboard appends one JSON
object per line to it for every interaction its callbacks see (ask, answer,
moment focus, verdict, refine, clear, export). Each browser session gets a short
random code, shown in the top bar, that the participant copies into the study
form; it is the only link between a form response and the log lines. Unset, the
dashboard looks and behaves exactly as before and nothing is written.

The log never records IP addresses, user agents or the basic-auth username.
Plays inside the YouTube embeds are cross-origin and cannot be observed.

The file is opened with a plain ``open(..., "a")``, so a new log gets the mode
the process umask allows (the Slurm jobs set ``umask 0007`` for group sharing).
"""

from __future__ import annotations

import json
import os
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

ENV_VAR = "CASTLERAG_STUDY_LOG"

# No 0/O, 1/I/L: the participant retypes the code into a form.
SESSION_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
SESSION_CODE_LENGTH = 6


def new_session_code() -> str:
    """Return a fresh random session code from the unambiguous alphabet."""
    return "".join(
        secrets.choice(SESSION_CODE_ALPHABET) for _ in range(SESSION_CODE_LENGTH)
    )


def is_session_code(value: object) -> bool:
    """True when ``value`` looks like a code :func:`new_session_code` made."""
    return (
        isinstance(value, str)
        and len(value) == SESSION_CODE_LENGTH
        and all(ch in SESSION_CODE_ALPHABET for ch in value)
    )


def _utc_now() -> str:
    """UTC ISO-8601 timestamp with milliseconds, e.g. 2026-10-29T12:00:00.123Z."""
    return (
        datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class StudyLog:
    """Thread-safe JSONL appender; a no-op when built without a path."""

    def __init__(self, path: Optional[str | Path]) -> None:
        self.path = Path(path) if path else None
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "StudyLog":
        return cls(os.getenv(ENV_VAR, "").strip() or None)

    @property
    def enabled(self) -> bool:
        return self.path is not None

    def log(self, session: Optional[str], event: str, **fields: object) -> None:
        """Append one event line. Dash may serve callbacks from several threads,
        so the lock keeps lines whole; each line is flushed as it is written."""
        if self.path is None:
            return
        record = {"ts": _utc_now(), "session": session, "event": event, **fields}
        line = json.dumps(record, ensure_ascii=False, default=str) + "\n"
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(line)
                fh.flush()
