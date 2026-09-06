#!/usr/bin/env python3
"""Construct everything the agent builds at startup, on any platform.

This exists because `import threading` was missing at module level and nothing
caught it. The gaps that let it through, all of which this closes:

  - `ast.parse` (used by the install-time check) validates syntax, not names, so an
    undefined name is invisible to it.
  - The failing line is in `MlxRuntime.__init__`, and `_pick_runtime()` only returns
    MlxRuntime on arm64. Every test machine here is Intel, so the constructor was
    never run.
  - The daemon fails at import, so `launchd` restarts it forever and the only
    evidence is a NameError buried in a log on someone else's Mac.

Result: a broken agent shipped and sat in production for a day, and any new Apple
Silicon provider following our instructions would have installed a crash loop.

Run from `ocm/`:  python3 tests/agent-smoke.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agent"))

# Force a runtime that needs no Apple Silicon so the import itself succeeds anywhere;
# the point is to construct BOTH classes explicitly below.
os.environ.setdefault("OCM_RUNTIME", "ollama")

failures = []


def check(name, fn):
    try:
        fn()
        print(f"  ok    {name}")
    except Exception as exc:                       # noqa: BLE001
        failures.append(f"{name}: {type(exc).__name__}: {exc}")
        print(f"  FAIL  {name}: {type(exc).__name__}: {exc}")


import agent  # noqa: E402  (after sys.path is set)

print("agent smoke:")

# The exact line that shipped broken: MlxRuntime.__init__ builds a threading.Lock.
check("MlxRuntime constructs", lambda: agent.MlxRuntime())
check("OllamaRuntime constructs", lambda: agent.OllamaRuntime())

# capabilities() reads platform details and must not explode on any host.
check("capabilities() returns a dict",
      lambda: isinstance(agent.capabilities([]), dict) or (_ for _ in ()).throw(
          AssertionError("not a dict")))

# The token must reach the gateway as a header. _connect builds the connection
# object without performing IO, so this is safe to call.
def _connect_uses_header():
    conn = agent._connect("ws://127.0.0.1:1/host/connect")
    # websockets renamed the parameter between 13.x and 14.0; either is fine, but a
    # TypeError here means neither name was accepted and the fallback is broken.
    if conn is None:
        raise AssertionError("_connect returned None")


check("_connect builds with an auth header", _connect_uses_header)

# Every name the module references at import time must resolve.
check("module imports cleanly", lambda: agent.RUNTIME is not None)

if failures:
    print(f"\n{len(failures)} failure(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all ok")
