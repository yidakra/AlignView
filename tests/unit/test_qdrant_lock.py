"""scripts/slurm/qdrant_lock.sh: one Qdrant server per storage folder."""

import os
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / "scripts" / "slurm" / "qdrant_lock.sh"


@pytest.fixture
def env(tmp_path):
    """A fake `sacct`: states.txt maps "<job> <STATE>"; FAIL_SACCT=1 makes it
    fail; REWRITE_LOCK=<path> makes it overwrite that lock (a racing job)."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    states = tmp_path / "states.txt"
    states.write_text("")
    sacct = bindir / "sacct"
    sacct.write_text(
        "#!/bin/sh\n"
        '[ -n "$FAIL_SACCT" ] && exit 1\n'
        '[ -n "$REWRITE_LOCK" ] && '
        'echo "carol 909 gcn9 2026-01-01T00:00:00" > "$REWRITE_LOCK"\n'
        'job=""\n'
        'while [ $# -gt 0 ]; do [ "$1" = "-j" ] && job="$2"; shift; done\n'
        f'awk -v j="$job" \'$1==j {{print $2}}\' "{states}"\n'
    )
    sacct.chmod(0o755)
    # Fake squeue: SQUEUE_MODE=running (default) | empty | invalid | error
    squeue = bindir / "squeue"
    squeue.write_text(
        "#!/bin/sh\n"
        'case "${SQUEUE_MODE:-running}" in\n'
        "  running) echo RUNNING ;;\n"
        "  empty) ;;\n"
        "  invalid) echo 'slurm_load_jobs error: Invalid job id specified' >&2;"
        " exit 1 ;;\n"
        "  error) echo 'Socket timed out on send/recv operation' >&2; exit 1 ;;\n"
        "esac\n"
    )
    squeue.chmod(0o755)
    base = dict(
        os.environ,
        PATH=f"{bindir}:{os.environ['PATH']}",
        USER="alice",
        QDRANT_LOCK_READ_TRIES="1",
    )
    base.pop("FAIL_SACCT", None)
    base.pop("REWRITE_LOCK", None)
    base.pop("SQUEUE_MODE", None)
    return tmp_path, states, base


def run(script, env, job):
    e = dict(env)
    e.pop("SLURM_JOB_ID", None)
    if job is not None:
        e["SLURM_JOB_ID"] = str(job)
    return subprocess.run(
        ["bash", "-c", f'source "{HELPER}"; {script}'],
        env=e,
        capture_output=True,
        text=True,
    )


def holder(store):
    return (store / ".castlerag-qdrant.lock").read_text().split()[:2]


def test_first_job_takes_the_lock(env):
    tmp, _, base = env
    store = tmp / "qdrant_storage"
    r = run(f'qdrant_lock "{store}"', base, 101)
    assert r.returncode == 0, r.stderr
    assert holder(store) == ["alice", "101"]


@pytest.mark.parametrize("state", ["RUNNING", "PENDING", "REQUEUED", "UNKNOWN", ""])
def test_lock_kept_unless_holder_has_ended(env, state):
    tmp, states, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    states.write_text(f"101 {state}\n" if state else "")
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 4
    assert "in use by alice's job 101" in r.stderr
    assert holder(store) == ["alice", "101"]


def test_sacct_failure_keeps_the_lock(env):
    tmp, _, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob", FAIL_SACCT="1"), 202)
    assert r.returncode == 4
    assert holder(store) == ["alice", "101"]


@pytest.mark.parametrize("state", ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"])
def test_lock_of_ended_job_is_taken_over(env, state):
    tmp, states, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    states.write_text(f"101 {state}\n")
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 0, r.stderr
    assert "took over a stale lock" in r.stdout
    assert holder(store) == ["bob", "202"]
    assert not (store / ".castlerag-qdrant.lock.takeover").exists()


def test_takeover_refused_while_another_job_holds_the_mutex(env):
    tmp, states, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    states.write_text("101 COMPLETED\n")
    (store / ".castlerag-qdrant.lock.takeover").mkdir()
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 4
    assert "taking over the stale lock right now" in r.stderr
    assert holder(store) == ["alice", "101"]


def test_takeover_refused_if_lock_changes_hands_mid_check(env):
    tmp, states, base = env
    store = tmp / "qdrant_storage"
    lock = store / ".castlerag-qdrant.lock"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    states.write_text("101 COMPLETED\n")
    # carol's job grabs the lock while bob is asking sacct about alice's
    r = run(
        f'qdrant_lock "{store}"', dict(base, USER="bob", REWRITE_LOCK=str(lock)), 202
    )
    assert r.returncode == 4
    assert "changed hands" in r.stderr
    assert holder(store) == ["carol", "909"]
    assert not (store / ".castlerag-qdrant.lock.takeover").exists()


def test_empty_or_partial_lock_is_not_taken_over(env):
    tmp, _, base = env
    store = tmp / "qdrant_storage"
    store.mkdir()
    (store / ".castlerag-qdrant.lock").write_text("")
    r = run(f'qdrant_lock "{store}"', base, 202)
    assert r.returncode == 4
    assert "empty or partial" in r.stderr


def test_lock_held_outside_slurm_is_not_taken_over(env):
    tmp, _, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, None).returncode == 0
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 4
    assert "outside Slurm" in r.stderr


def test_unlock_only_removes_own_lock(env):
    tmp, _, base = env
    store = tmp / "qdrant_storage"
    lock = store / ".castlerag-qdrant.lock"
    r = run(f'qdrant_lock "{store}"; qdrant_unlock; test ! -e "{lock}"', base, 101)
    assert r.returncode == 0, r.stderr
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    other = f'QDRANT_LOCK_FILE="{lock}" QDRANT_LOCK_ID=other qdrant_unlock'
    assert run(other, base, 303).returncode == 0
    assert lock.exists()


@pytest.mark.parametrize(
    "mode,contender,taken",
    [
        ("invalid", "bob", True),  # controller: no such job, for anyone
        ("empty", "alice", True),  # own job no longer listed
        ("empty", "bob", False),  # another user's job may just be hidden
        ("running", "bob", False),
        ("error", "alice", False),
    ],
)
def test_no_sacct_record_falls_back_to_squeue(env, mode, contender, taken):
    tmp, states, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    states.write_text("")  # record purged, no accounting, or hidden
    r = run(f'qdrant_lock "{store}"', dict(base, USER=contender, SQUEUE_MODE=mode), 202)
    assert (r.returncode == 0) is taken, r.stderr
    assert holder(store) == ([contender, "202"] if taken else ["alice", "101"])


def test_mutex_of_ended_job_is_cleared(env):
    tmp, states, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    states.write_text("101 COMPLETED\n777 CANCELLED\n")
    mutex = store / ".castlerag-qdrant.lock.takeover"
    mutex.mkdir()
    (mutex / "owner").write_text("dave 777 gcn9 2026-01-01T00:00:00\n")
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 0, r.stderr
    assert "cleared a takeover mutex left by ended job 777" in r.stdout
    assert holder(store) == ["bob", "202"]
    assert not mutex.exists()


def test_mutex_of_live_job_is_never_cleared(env):
    tmp, states, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    states.write_text("101 COMPLETED\n777 RUNNING\n")
    mutex = store / ".castlerag-qdrant.lock.takeover"
    mutex.mkdir()
    (mutex / "owner").write_text("dave 777 gcn9 2026-01-01T00:00:00\n")
    old = mutex.stat().st_mtime - 3600  # age alone must not matter
    os.utime(mutex, (old, old))
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 4
    assert (mutex / "owner").read_text().split()[:2] == ["dave", "777"]
    assert holder(store) == ["alice", "101"]


def test_ownerless_mutex_is_cleared_only_when_old(env):
    tmp, states, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    states.write_text("101 COMPLETED\n")
    mutex = store / ".castlerag-qdrant.lock.takeover"
    mutex.mkdir()
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 4  # fresh: a contender may be about to record itself
    old = mutex.stat().st_mtime - 3600
    os.utime(mutex, (old, old))
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 0, r.stderr
    assert holder(store) == ["bob", "202"]


def test_mutex_left_outside_slurm_is_cleared_only_when_old(env):
    tmp, states, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    states.write_text("101 COMPLETED\n")
    mutex = store / ".castlerag-qdrant.lock.takeover"
    mutex.mkdir()
    (mutex / "owner").write_text("dave nojob laptop 2026-01-01T00:00:00\n")
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 4  # fresh: that run may still be mid-takeover
    old = mutex.stat().st_mtime - 3600
    os.utime(mutex, (old, old))
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 0, r.stderr
    assert holder(store) == ["bob", "202"]
    assert not list(store.glob(".castlerag-qdrant.lock.takeover.stale.*"))
