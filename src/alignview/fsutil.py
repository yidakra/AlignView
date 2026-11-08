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
import subprocess


def _read_umask_from_child() -> int:
    """The umask without touching ours: a child shell inherits it and prints
    it. Falls back to set-and-restore only if no shell can be run."""
    try:
        out = subprocess.run(
            ["/bin/sh", "-c", "umask"], capture_output=True, text=True, timeout=5
        ).stdout.strip()
        return int(out, 8)
    except (OSError, ValueError, subprocess.SubprocessError):
        mask = os.umask(0o077)
        os.umask(mask)
        return mask


_PROC_STATUS = "/proc/self/status"

# Off Linux (no /proc) the umask is read once, at import, from a child shell.
# On Linux it is read live from /proc and no shell is started.
_IMPORT_UMASK = None if os.path.exists(_PROC_STATUS) else _read_umask_from_child()


def current_umask() -> int:
    """The process umask, never changed to read it. Linux reads it live from
    /proc; elsewhere it is the value a child shell reported at import."""
    try:
        with open(_PROC_STATUS, encoding="ascii") as fh:
            for line in fh:
                if line.startswith("Umask:"):
                    return int(line.split()[1], 8)
    except OSError:
        pass
    global _IMPORT_UMASK
    if _IMPORT_UMASK is None:  # /proc existed at import but is unreadable now
        _IMPORT_UMASK = _read_umask_from_child()
    return _IMPORT_UMASK


def default_file_mode() -> int:
    """Mode bits ``open(path, "w")`` would give a new file right now."""
    return 0o666 & ~current_umask()


def share_tmp_file(fd: int) -> None:
    """Give a ``mkstemp`` file descriptor the default (umask-based) mode."""
    os.fchmod(fd, default_file_mode())
