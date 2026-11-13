#!/bin/sh
# debug.sh -- run JS8Map Spotter FROM SOURCE on Linux (the debug.bat of Linux).
# Settings and databases are written into this folder when run from source.
# Set PYTHON to use a particular interpreter, e.g.  PYTHON=python3.12 ./debug.sh
cd "$(dirname "$0")" || exit 1
PY="${PYTHON:-python3}"
if ! "$PY" -c "import tkinter" 2>/dev/null; then
    echo "JS8Map Spotter needs Python with Tk:  sudo apt install python3-tk"
    echo "(checked: $("$PY" --version 2>&1) at $(command -v "$PY"))"
    exit 1
fi
exec "$PY" JS8Map.py "$@"
