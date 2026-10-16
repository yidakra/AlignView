"""File-mode helper for atomic writes on shared storage.

``tempfile.mkstemp`` always creates its file as 0600, and ``os.replace`` keeps
that mode, so every temp-file-then-rename write ends up readable by its owner
only. On the shared project space that locks teammates out of caches every
time they are rebuilt. ``share_tmp_file`` gives the temp file the mode a plain
``open()`` would have produced under the process umask before it is renamed
into place.
"""

from __future__ import annotations

import os


def _read_umask_by_setting() -> int:
    mask = os.umask(0o077)
    os.umask(mask)
    return mask


# Without /proc (macOS) the umask can only be read by setting it, which other
# threads would briefly see. Read it once at import, before worker threads
# start, instead of on every call.
_IMPORT_UMASK = _read_umask_by_setting()


def current_umask() -> int:
    """The process umask. Linux reads it live from /proc without changing it;
    elsewhere it is the value at import time."""
    try:
        with open("/proc/self/status", encoding="ascii") as fh:
            for line in fh:
                if line.startswith("Umask:"):
                    return int(line.split()[1], 8)
    except OSError:
        pass
    return _IMPORT_UMASK


def default_file_mode() -> int:
    """Mode bits ``open(path, "w")`` would give a new file right now."""
    return 0o666 & ~current_umask()


def share_tmp_file(fd: int) -> None:
    """Give a ``mkstemp`` file descriptor the default (umask-based) mode."""
    os.fchmod(fd, default_file_mode())
