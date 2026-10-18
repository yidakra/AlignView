"""scripts/slurm/qdrant_lock.sh: one Qdrant server per storage folder."""

import os
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / "scripts" / "slurm" / "qdrant_lock.sh"


@pytest.fixture
def env(tmp_path):
    """A fake `squeue` that reports RUNNING for job ids listed in running.txt."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    running = tmp_path / "running.txt"
    running.write_text("")
    squeue = bindir / "squeue"
    squeue.write_text(
        "#!/bin/sh\n"
        'job=""\n'
        'while [ $# -gt 0 ]; do [ "$1" = "-j" ] && job="$2"; shift; done\n'
        f'grep -qx "$job" "{running}" && echo RUNNING\n'
        "exit 0\n"
    )
    squeue.chmod(0o755)
    base = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", USER="alice")
    return tmp_path, running, base


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


def test_first_job_takes_the_lock(env):
    tmp, _, base = env
    store = tmp / "qdrant_storage"
    r = run(f'qdrant_lock "{store}"', base, 101)
    assert r.returncode == 0, r.stderr
    assert (store / ".castlerag-qdrant.lock").read_text().split()[:2] == [
        "alice",
        "101",
    ]


def test_second_job_is_refused_while_holder_runs(env):
    tmp, running, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    running.write_text("101\n")
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 4
    assert "in use by alice's job 101" in r.stderr


def test_stale_lock_is_taken_over(env):
    tmp, running, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    running.write_text("")  # job 101 finished or crashed without unlocking
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 0, r.stderr
    assert "stale lock" in r.stdout
    assert (store / ".castlerag-qdrant.lock").read_text().split()[:2] == ["bob", "202"]


def test_unlock_only_removes_own_lock(env):
    tmp, _, base = env
    store = tmp / "qdrant_storage"
    lock = store / ".castlerag-qdrant.lock"
    r = run(f'qdrant_lock "{store}"; qdrant_unlock; test ! -e "{lock}"', base, 101)
    assert r.returncode == 0, r.stderr
    assert run(f'qdrant_lock "{store}"', base, 101).returncode == 0
    # another job's unlock (no matching id) leaves the lock in place
    other = f'QDRANT_LOCK_FILE="{lock}" QDRANT_LOCK_ID=other qdrant_unlock'
    assert run(other, base, 303).returncode == 0
    assert lock.exists()


def test_lock_held_outside_slurm_is_not_taken_over(env):
    tmp, _, base = env
    store = tmp / "qdrant_storage"
    assert run(f'qdrant_lock "{store}"', base, None).returncode == 0
    r = run(f'qdrant_lock "{store}"', dict(base, USER="bob"), 202)
    assert r.returncode == 4
    assert "outside Slurm" in r.stderr
