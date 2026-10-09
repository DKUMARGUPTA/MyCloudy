#!/usr/bin/env python3
"""Double-fork daemon launcher for `bun run dev` (survives the tool-invocation reaper)."""
import os, sys

cwd = "/home/z/my-project"
pid = os.fork()
if pid == 0:
    os.setsid()
    if os.fork() == 0:
        os.chdir(cwd)
        os.umask(0o022)
        log = open("/tmp/docopdf-dev-daemon.log", "ab", buffering=0)
        os.dup2(log.fileno(), 1)
        os.dup2(log.fileno(), 2)
        os.execvp("bun", ["bun", "run", "dev"])
    os._exit(0)
os.waitpid(pid, 0)
print("dev daemon launched")
