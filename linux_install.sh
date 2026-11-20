#!/bin/sh
# linux_install.sh -- first-time setup of JS8Map Spotter on Linux.
#
#   unzip ~/Downloads/JS8Map_Spotter_Ver_*_build_*.zip -d ~/JS8MapSpotter
#   sh ~/JS8MapSpotter/Spotter*/linux_install.sh
#
# What it does (2026-10-29):
#   1. checks for Python 3.8+ with Tk (needed), and unzip and wmctrl
#      (recommended); if any are missing it shows the apt command and offers
#      to run it (asks for your password; nothing is installed without a yes);
#   2. checks for a Chromium-family browser for the map window;
#   3. restores the "executable" marks a Windows PC may have dropped;
#   4. adds the menu entry and desktop icon (tools/install_linux_launcher.sh);
#   5. reminds you of the JS8Call settings and how to update later.
# Safe to run again. Does not start the program and does not touch JS8Map 1.75.
set -e

say()  { printf '%s\n' "$*"; }
ask()  {
    printf '%s [y/N] ' "$1"
    # Only ask a person at a terminal (29c). Run by a test or a script
    # (stdin not a terminal), or with JS8MAP_ASSUME_NO=1: the answer is no,
    # at once -- it never waits for a key nobody can see.
    a=''
    if [ -z "${JS8MAP_ASSUME_NO:-}" ] && [ -t 0 ]; then read -r a || a=''; else printf '(no)\n'; fi
    case "$a" in [Yy]|[Yy][Ee][Ss]) return 0 ;; *) return 1 ;; esac
}

APP="$(cd "$(dirname "$0")" && pwd)"
[ -f "$APP/JS8Map.py" ] || { say "STOP: run this from the unzipped Spotter folder."; exit 1; }
PY="${PYTHON:-python3}"

say "JS8Map Spotter -- Linux setup"
say "  folder: $APP"
say ""

# --- 1. what is needed ---------------------------------------------------------------
check() {
    NEED=''; WANT=''
    if ! command -v "$PY" >/dev/null 2>&1; then
        NEED="$NEED python3"
    elif ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
        say "  Python: $("$PY" --version 2>&1) is too old (3.8 or newer needed)."
        NEED="$NEED python3"
    fi
    if command -v "$PY" >/dev/null 2>&1 && ! "$PY" -c 'import tkinter' 2>/dev/null; then
        NEED="$NEED python3-tk"
    fi
    command -v unzip  >/dev/null 2>&1 || WANT="$WANT unzip"
    command -v wmctrl >/dev/null 2>&1 || WANT="$WANT wmctrl"
}
check
if [ -n "$NEED$WANT" ]; then
    [ -n "$NEED" ] && say "  Needed, missing:      $NEED"
    [ -n "$WANT" ] && say "  Recommended, missing: $WANT   (unzip: for updates; wmctrl: brings the map forward)"
    say ""
    say "  Install command:  sudo apt install$NEED$WANT"
    if command -v apt-get >/dev/null 2>&1 && ask "  Run it now?"; then
        sudo apt-get install -y $NEED $WANT || say "  (the install did not finish; see the messages above)"
        check
    fi
fi
if [ -n "$NEED" ]; then
    say ""
    say "STOP: still missing:$NEED"
    say "Install it (command above), then run this again."
    exit 1
fi
say "  Python: $("$PY" --version 2>&1) with Tk -- OK"

# --- 2. a browser for the map window (same list as js8map_platform/linux.py) ---------
BROWSER=''
for b in brave-browser brave google-chrome-stable google-chrome microsoft-edge-stable \
         microsoft-edge chromium chromium-browser; do
    if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
done
if [ -n "$BROWSER" ]; then
    say "  Map window browser: $BROWSER -- OK"
else
    say "  Map window browser: none of Brave / Chrome / Edge / Chromium found."
    say "    The map will open in your normal browser instead. For its own window:"
    say "    sudo apt install chromium      (or install Brave or Chrome)"
fi

# --- 3 + 4. marks and launchers ---------------------------------------------------------
chmod +x "$APP/debug.sh" "$APP/update_linux.sh" "$APP/linux_install.sh" \
         "$APP"/tools/*.sh 2>/dev/null || true
sh "$APP/tools/install_linux_launcher.sh" >/dev/null
say "  Menu entry and desktop icon -- added"

# --- 5. next steps -------------------------------------------------------------------------
say ""
say "DONE. Next:"
say "  1. In JS8Call: File > Settings > Reporting -- tick Enable TCP Server API and"
say "     Accept TCP Requests, port 2442, TCP Max Connections 5. Restart JS8Call."
say "  2. Start JS8Map Spotter from the desktop icon (or the menu, Ham Radio)."
say "     The first time, a setup wizard downloads the FCC callsign database."
say "  3. Later updates: save the new zip in Downloads, close Spotter, then run"
say "       sh ~/JS8MapSpotter/Spotter*/update_linux.sh"
say "     (if you unzipped somewhere else, use that folder instead of ~/JS8MapSpotter)."
