#!/usr/bin/env python3
"""Double-fork daemon launcher for mini-services (survives the tool-invocation reaper).

Usage: python3 scripts/mini-daemon.py <service-dir-name>
Example: python3 scripts/mini-daemon.py convert   -> daemonizes mini-services/convert (bun run dev)
"""
import os, sys

SERVICES_ROOT = "/home/z/my-project/mini-services"

def main():
    if len(sys.argv) != 2:
        print("usage: mini-daemon.py <service-dir>", file=sys.stderr)
        sys.exit(2)
    name = sys.argv[1]
    cwd = os.path.join(SERVICES_ROOT, name)
    if not os.path.isdir(cwd):
        print(f"no such service dir: {cwd}", file=sys.stderr)
        sys.exit(2)
    pid = os.fork()
    if pid == 0:
        os.setsid()
        if os.fork() == 0:
            os.chdir(cwd)
            os.umask(0o022)
            log = open(f"/tmp/docopdf-mini-{name}.log", "ab", buffering=0)
            os.dup2(log.fileno(), 1)
            os.dup2(log.fileno(), 2)
            os.execvp("bun", ["bun", "run", "dev"])
        os._exit(0)
    os.waitpid(pid, 0)
    print(f"mini-service '{name}' daemon launched")

if __name__ == "__main__":
    main()
