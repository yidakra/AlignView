"""Atomic writes must leave files with the umask-based mode, not mkstemp's 0600."""

import os
import stat

import numpy as np
import pytest

from alignview.fsutil import current_umask, default_file_mode, share_tmp_file
from alignview.index.io import write_embedding_cache


@pytest.fixture
def group_umask():
    old = os.umask(0o007)
    try:
        yield
    finally:
        os.umask(old)


def test_current_umask_does_not_change_the_umask(group_umask):
    current_umask()
    current_umask()
    assert os.umask(0o007) == 0o007  # still what the fixture set


@pytest.fixture
def import_umask_007(monkeypatch):
    # Off Linux the umask is captured at import; pin it so the mode tests
    # don't depend on the platform or on the umask pytest started with.
    import alignview.fsutil as fsutil

    monkeypatch.setattr(fsutil, "_IMPORT_UMASK", 0o007)
    monkeypatch.setattr(fsutil, "current_umask", lambda: 0o007)


def test_default_file_mode_follows_umask(group_umask, import_umask_007):
    assert default_file_mode() == 0o660


def test_share_tmp_file_sets_mode(tmp_path, group_umask, import_umask_007):
    import tempfile

    fd, name = tempfile.mkstemp(dir=tmp_path)
    try:
        assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o600
        share_tmp_file(fd)
        assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o660
    finally:
        os.close(fd)


def test_embedding_cache_is_group_readable(tmp_path, group_umask, import_umask_007):
    path = write_embedding_cache(
        ["a", "b"], np.zeros((2, 3), dtype=np.float32), tmp_path / "clips_day1.npz"
    )
    assert stat.S_IMODE(path.stat().st_mode) == 0o660


def test_child_shell_reports_the_umask_without_changing_it(group_umask):
    import alignview.fsutil as fsutil

    assert fsutil._read_umask_from_child() == 0o007
    assert os.umask(0o007) == 0o007
