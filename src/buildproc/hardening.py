#!/usr/bin/env python3
"""One prctl in the HUB process, which is what keeps a build out of its environ.

Everything else in this package fences in the BUILD. This module is the one
piece that runs in the hub itself, and it exists because of a hole the fence
cannot close from the other side.

THE HOLE. `runner.child_environment` builds the build's environment key by key,
so no token is ever passed to it -- and that is true and still not enough. The
build runs under the SAME uid as the hub (both are `app`; the entrypoint drops
to it once and every process descends from there) and in the SAME pid namespace
(one container, no nesting). The hub's own environment holds EDIT_TOKEN --
the one secret of the whole system -- because compose delivers it through
`environment:`, and on
Linux `/proc/<pid>/environ` is readable by a process that passes
`PTRACE_MODE_READ_FSCREDS` -- which same-uid, same-userns satisfies. It is NOT
the `PTRACE_MODE_ATTACH` check that Yama's `ptrace_scope=1` restricts, so the
usual hardening does not apply. A model therefore reads the hub's token with
`open("/proc/<pid>/environ")`, and no line of `child_environment` is wrong.

THE CLOSE. `prctl(PR_SET_DUMPABLE, 0)` clears the task's dumpable flag. Linux
then hands ownership of `/proc/<pid>/` to root:root and the read of `environ`,
`cmdline`, `mem`, `maps` and the rest fails with EACCES for everyone but root
and the process itself (`proc_pid_permission` in fs/proc/base.c consults exactly
that flag). The flag is per-process and RESET TO 1 BY `execve`, which is why it
has to be set here rather than once in the entrypoint: `gosu` execs, and every
build the hub starts execs too, so nothing inherits it in either direction.

Not in the standard library -- there is no `os.prctl` -- so it goes through
`ctypes`, with the result read back rather than assumed.

WHAT IT DOES NOT BUY. The environment is one place a token can be read from and
not the only one: `/proc/<pid>/environ` is closed, `/app/data` still is not (see
the package docstring). This closes the hole it names.
"""

import ctypes
import os
import sys


# include/uapi/linux/prctl.h. Stable since 2.6 and part of the kernel ABI, which
# is why they are literals here rather than looked up: nothing in the standard
# library exposes them, and they cannot change without breaking every program on
# the system.
PR_SET_DUMPABLE = 4
PR_GET_DUMPABLE = 3

# What `PR_SET_DUMPABLE` is set to. 0 is SUID_DUMP_DISABLE: no core dump, and
# `/proc/<pid>/` owned by root.
_NOT_DUMPABLE = 0


class HardeningFailed(RuntimeError):
    """The prctl did not take on a platform where it must.

    Raised, rather than logged and shrugged off, because the failure is silent
    in every other way: the hub serves traffic perfectly with its environment
    readable by every build it runs, and nothing anywhere would say so.
    """


def hide_process_from_same_uid():
    """Make `/proc/<this pid>/*` unreadable by other processes of this uid.

    Returns a one-line description of what happened, for the hub's log -- the
    call is invisible otherwise, and "it was applied" and "this platform has no
    /proc to protect" have to be distinguishable in a log six months later.

    Raises `HardeningFailed` on Linux if the flag would not go on or does not
    read back as cleared. Off Linux this is a documented no-op: there is no
    `/proc/<pid>/environ` to read in the first place (macOS has no procfs, and
    its `sysctl KERN_PROCARGS2` already refuses another process's environment to
    a non-root caller), and the hub's production platform is a Linux container.
    """
    if not sys.platform.startswith("linux"):
        return (f"buildproc: /proc/<pid>/environ hiding is a no-op on "
                f"{sys.platform}; the hub runs on Linux, where it is not")

    try:
        libc = ctypes.CDLL(None, use_errno=True)
        # Declared rather than left to ctypes' default int-everything guess: the
        # kernel reads all four optional arguments as `unsigned long`, and on
        # LP64 a default-marshalled Python int would be passed in a 32-bit
        # register half. The values here are all 0, so the difference is
        # invisible today and would not be the day one of them is not.
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

    # Read back. `PR_SET_DUMPABLE` is one of the prctls a seccomp filter can be
    # configured to allow while quietly discarding, and the whole value of this
    # call is a property of the kernel's view rather than of the return code we
    # just checked.
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
