#!/usr/bin/env python3
"""One prctl in the HUB process, which is what keeps a build out of its environ.

Everything else in this package fences in the build; this runs in the hub.

The hole: `runner.child_environment` passes the build no token, but the build
runs under the same uid as the hub (`app`) in the same pid namespace, and the
hub's environment holds EDIT_TOKEN (delivered by compose `environment:`).
`/proc/<pid>/environ` is readable under `PTRACE_MODE_READ_FSCREDS`, which
same-uid satisfies; Yama's `ptrace_scope=1` restricts only
`PTRACE_MODE_ATTACH`. So a model could `open("/proc/<pid>/environ")`.

The fix: `prctl(PR_SET_DUMPABLE, 0)` makes Linux hand `/proc/<pid>/` to
root:root, so `environ`, `cmdline`, `mem`, `maps` fail with EACCES for anyone
but root and the process itself (`proc_pid_permission` in fs/proc/base.c). The
flag is per-process and reset to 1 by `execve`, so it is set here rather than
in the entrypoint (`gosu` execs, and so does every build).

There is no `os.prctl`, so it goes through `ctypes`, and the result is read
back. This closes `/proc/<pid>/environ` only; `/app/data` is still readable
(see the package docstring).
"""

import ctypes
import os
import sys


# include/uapi/linux/prctl.h; part of the kernel ABI and not exposed by the
# standard library.
PR_SET_DUMPABLE = 4
PR_GET_DUMPABLE = 3

# What `PR_SET_DUMPABLE` is set to. 0 is SUID_DUMP_DISABLE: no core dump, and
# `/proc/<pid>/` owned by root.
_NOT_DUMPABLE = 0


class HardeningFailed(RuntimeError):
    """The prctl did not take on a platform where it must.

    Raised rather than logged: the failure is otherwise silent, the hub keeps
    serving with its environment readable by every build.
    """


def hide_process_from_same_uid():
    """Make `/proc/<this pid>/*` unreadable by other processes of this uid.

    Returns a one-line description for the hub's log, so "applied" and "no
    /proc on this platform" are distinguishable.

    Raises `HardeningFailed` on Linux if the flag would not go on or does not
    read back as cleared. Off Linux it is a no-op: there is no procfs (macOS's
    `sysctl KERN_PROCARGS2` already refuses another process's environment to
    non-root), and production is a Linux container.
    """
    if not sys.platform.startswith("linux"):
        return (f"buildproc: /proc/<pid>/environ hiding is a no-op on "
                f"{sys.platform}; the hub runs on Linux, where it is not")

    try:
        libc = ctypes.CDLL(None, use_errno=True)
        # Declared explicitly: the kernel reads the optional arguments as
        # `unsigned long`, which ctypes' default int marshalling does not match
        # on LP64.
        libc.prctl.restype = ctypes.c_int
        libc.prctl.argtypes = [ctypes.c_int] + [ctypes.c_ulong] * 4
    except (OSError, AttributeError) as exc:
        raise HardeningFailed(
            f"cannot reach prctl(2) through libc: {exc}") from exc

    ctypes.set_errno(0)
    if libc.prctl(PR_SET_DUMPABLE, _NOT_DUMPABLE, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise HardeningFailed(
            f"prctl(PR_SET_DUMPABLE, 0) failed with errno {code} "
            f"({os.strerror(code)}), so this process's /proc entry stays "
            f"readable by every build it runs -- and the hub's environment "
            f"holds the publish token")

    # Read back: a seccomp filter can allow `PR_SET_DUMPABLE` while silently
    # discarding it, and what matters is the kernel's view.
    ctypes.set_errno(0)
    dumpable = libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0)
    if dumpable != _NOT_DUMPABLE:
        raise HardeningFailed(
            f"prctl(PR_SET_DUMPABLE, 0) returned success but the flag reads "
            f"back as {dumpable}, so /proc/{os.getpid()}/environ is still "
            f"readable by this uid")

    return ("buildproc: /proc/<pid>/environ of this process is now root-only "
            "(PR_SET_DUMPABLE=0), so a build cannot read the hub's tokens out "
            "of it")
