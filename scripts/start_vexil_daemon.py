#!/usr/bin/env python3
"""Double-fork launcher — starts vexil_master.py as a true daemon, detached from any shell."""
import os, sys

script = os.path.join(os.path.dirname(__file__), 'vexil_master.py')

# First fork
pid = os.fork()
if pid > 0:
    print(f'[vexil-launcher] daemon PID: {pid}')
    sys.exit(0)

os.setsid()  # new session, detach from terminal

# Second fork — prevents re-acquisition of controlling terminal
pid = os.fork()
if pid > 0:
    sys.exit(0)

# Redirect stdio
with open('/tmp/vexil_master.log', 'a') as log:
    os.dup2(log.fileno(), sys.stdout.fileno())
    os.dup2(log.fileno(), sys.stderr.fileno())
with open('/dev/null') as devnull:
    os.dup2(devnull.fileno(), sys.stdin.fileno())

os.execv(sys.executable, [sys.executable, script])
