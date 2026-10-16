"""Atomic writes must leave files with the umask-based mode, not mkstemp's 0600."""

import os
import stat

import numpy as np
import pytest

from castlerag.fsutil import current_umask, default_file_mode, share_tmp_file
from castlerag.index.io import write_embedding_cache


@pytest.fixture
def group_umask():
    old = os.umask(0o007)
    try:
        yield
    finally:
        os.umask(old)


def test_current_umask_reads_without_changing(group_umask):
    assert current_umask() == 0o007
    assert current_umask() == 0o007


def test_default_file_mode_follows_umask(group_umask):
    assert default_file_mode() == 0o660


def test_share_tmp_file_sets_mode(tmp_path, group_umask):
    import tempfile

    fd, name = tempfile.mkstemp(dir=tmp_path)
    try:
        assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o600
        share_tmp_file(fd)
        assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o660
    finally:
        os.close(fd)


def test_embedding_cache_is_group_readable(tmp_path, group_umask):
    path = write_embedding_cache(
        ["a", "b"], np.zeros((2, 3), dtype=np.float32), tmp_path / "clips_day1.npz"
    )
    assert stat.S_IMODE(path.stat().st_mode) == 0o660
