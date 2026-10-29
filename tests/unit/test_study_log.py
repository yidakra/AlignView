"""Opt-in user-study interaction log (CASTLERAG_STUDY_LOG)."""

import json
import re
import threading

import pytest

from castlerag.ui.study_log import (
    ENV_VAR,
    SESSION_CODE_ALPHABET,
    SESSION_CODE_LENGTH,
    StudyLog,
    is_session_code,
    new_session_code,
)

_TS_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


def _lines(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def _ids(component):
    """Every component id in a Dash layout tree."""
    found = []
    stack = [component]
    while stack:
        node = stack.pop()
        if isinstance(node, (list, tuple)):
            stack.extend(node)
            continue
        if getattr(node, "id", None) is not None:
            found.append(node.id)
        children = getattr(node, "children", None)
        if children is not None and not isinstance(children, str):
            stack.append(children)
    return found


def test_session_code_alphabet_and_length():
    for _ in range(200):
        code = new_session_code()
        assert len(code) == SESSION_CODE_LENGTH == 6
        assert set(code) <= set(SESSION_CODE_ALPHABET)
        assert is_session_code(code)
    assert not set("01ILO") & set(SESSION_CODE_ALPHABET)
    assert not is_session_code(None)
    assert not is_session_code("K7F2Q")
    assert not is_session_code("K7F2Q0")


def test_log_writes_jsonl_with_required_fields(tmp_path):
    path = tmp_path / "nested" / "dir" / "study.jsonl"
    log = StudyLog(path)
    log.log("K7F2QX", "page_load")
    log.log("K7F2QX", "ask", question="Who is in the kitchen?", is_refinement=False)

    first, second = _lines(path)
    for rec in (first, second):
        assert {"ts", "session", "event"} <= rec.keys()
        assert _TS_RE.match(rec["ts"])
        assert rec["session"] == "K7F2QX"
    assert first["event"] == "page_load"
    assert second["event"] == "ask"
    assert second["question"] == "Who is in the kitchen?"
    assert second["is_refinement"] is False


def test_disabled_when_env_unset(monkeypatch, tmp_path):
    monkeypatch.delenv(ENV_VAR, raising=False)
    monkeypatch.chdir(tmp_path)
    log = StudyLog.from_env()
    assert not log.enabled
    log.log("K7F2QX", "page_load")
    assert list(tmp_path.iterdir()) == []


def test_enabled_from_env(monkeypatch, tmp_path):
    path = tmp_path / "study.jsonl"
    monkeypatch.setenv(ENV_VAR, str(path))
    log = StudyLog.from_env()
    assert log.enabled and log.path == path


def test_summary_counts_sessions_and_skips_bad_lines():
    import importlib.util
    from pathlib import Path

    script = Path(__file__).parents[2] / "scripts" / "study_log_summary.py"
    spec = importlib.util.spec_from_file_location("study_log_summary", script)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    rows = mod.summarize([
        '{"ts": "t1", "session": "AAAAAA", "event": "ask"}',
        '{"ts": "t2", "session": "AAAAAA", "event": "answer", "latency_ms": 40}',
        '{"ts": "t3", "session": "AAAAAA", "event": "verdict"}',
        "not json",
        "[1, 2]",  # valid JSON, not an event object
        "42",
    ])
    assert list(rows) == ["AAAAAA"]
    row = rows["AAAAAA"]
    assert (row["asks"], row["answers"], row["verdicts"]) == (1, 1, 1)
    assert row["latencies"] == [40]


def test_concurrent_writes_do_not_interleave(tmp_path):
    path = tmp_path / "study.jsonl"
    log = StudyLog(path)
    payload = "x" * 4000  # long lines make a torn write likely without the lock

    def worker(n):
        for i in range(100):
            log.log(f"S{n}", "ask", question=payload, i=i)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    records = _lines(path)  # every line parses as one JSON object
    assert len(records) == 800
    assert all(r["question"] == payload for r in records)


def test_layout_has_no_session_code_unless_study():
    from castlerag.ui.layout import build_layout
    from castlerag.ui.youtube import YouTubeMirror

    mirror = YouTubeMirror.from_csv()
    off = _ids(build_layout(mirror))
    assert "session-code" not in off and "study-session" not in off
    on = _ids(build_layout(mirror, study=True))
    assert "session-code" in on and "study-session" in on


def _callback(app, name):
    for spec in app.callback_map.values():
        fn = getattr(spec.get("callback"), "__wrapped__", None)
        if fn is not None and fn.__name__ == name:
            return fn
    raise LookupError(name)


def test_build_app_without_env_registers_no_study_callback(monkeypatch):
    pytest.importorskip("dash")
    monkeypatch.delenv(ENV_VAR, raising=False)
    from castlerag.ui.app import build_app

    app = build_app()
    assert "session-code" not in _ids(app.layout)
    assert not any("study-session" in key for key in app.callback_map)


def test_page_load_and_ask_callbacks_log_events(monkeypatch, tmp_path):
    pytest.importorskip("dash")
    path = tmp_path / "study.jsonl"
    monkeypatch.setenv(ENV_VAR, str(path))
    from castlerag.ui.app import build_app

    app = build_app()

    code, badge = _callback(app, "on_study_session")(None)
    assert is_session_code(code)
    assert badge[0] == "Session code: "
    # A reload hands the stored code back; it is kept, not reissued.
    assert _callback(app, "on_study_session")(code)[0] == code

    _callback(app, "on_ask_new")(
        {"q": "Who is cooking?", "n": 1}, [], {}, {}, {}, code
    )

    records = _lines(path)
    assert [r["event"] for r in records] == [
        "page_load", "page_load", "ask", "answer",
    ]
    assert all(r["session"] == code for r in records)
    # First load issues the code; the reload reuses it.
    assert [r["new_session"] for r in records[:2]] == [True, False]
    ask, answer = records[2], records[3]
    assert ask["question"] == "Who is cooking?"
    assert ask["is_refinement"] is False
    assert ask["group_id"] == answer["group_id"] == "g1"
    assert answer["latency_ms"] >= 0
    assert answer["n_moments"] > 0
    assert answer["support"] in {"supported", "partial", "unsupported"}
    assert answer["error"] is False and answer["empty"] is False
