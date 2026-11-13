#!/bin/sh
# build_linux.sh -- build the ready-to-run Linux package of JS8Map Spotter.
#
#   sh build_linux.sh            (from the program folder)
#
# Makes ONE file to send to other Linux users (they don't need Python):
#     output/JS8Map_Spotter_v<version>_build_<tag>_linux.tar.gz
# and copies it to ~/Downloads. They install it with:
#     tar -C ~/Downloads -xzf ~/Downloads/JS8Map_Spotter_v..._linux.tar.gz
#     bash ~/Downloads/JS8Map_Spotter_v<version>_linux/install.sh
#
# The first build downloads PyInstaller into a private folder here (.buildenv):
# it needs the internet and a few minutes. Nothing is installed system-wide.
# Never asks a question. Any problem ends with STOP: and the reason.
# The package runs on the same Linux version as this PC, or newer (64-bit PC).
set -eu

say()  { printf '%s\n' "$*"; }
stop() { printf '\nSTOP: %s\nNo package was made.\n' "$*" >&2; exit 1; }

APP="$(cd "$(dirname "$0")" && pwd)"
cd "$APP"
[ -f JS8Map.py ] && [ -f JS8Map_linux.spec ] && [ -f make_js8map_package.sh ] \
    || stop "run this inside the program folder:  sh build_linux.sh"

# --- version and build tag -------------------------------------------------------
VERSION="$(sed -n "s/^APP_VERSION *= *['\"]\([^'\"]*\)['\"].*/\1/p" js8map_runtime.py | head -n 1)"
TAG_PY="$(sed -n "s/^STATREP_BUILD *= *'\([^']*\)'.*/\1/p" js8map_statrep.py | head -n 1)"
TAG_JS="$(sed -n "s/^const SR_PAGE_BUILD *= *'\([^']*\)'.*/\1/p" app.js | head -n 1)"
PKGVER="$(sed -n 's/^VERSION="\([^"]*\)".*/\1/p' make_js8map_package.sh | head -n 1)"
say "JS8Map Spotter -- Linux package build"
say "  folder:   $APP"
say "  version:  ${VERSION:-?}   build: ${TAG_PY:-?}"
[ -n "$VERSION" ] && [ -n "$TAG_PY" ] || stop "could not read the version or the build tag"
[ "$TAG_PY" = "$TAG_JS" ] || stop "the two build tags differ ($TAG_PY / $TAG_JS) -- make them the same:
      STATREP_BUILD in js8map_statrep.py and SR_PAGE_BUILD in app.js"
[ "$PKGVER" = "$VERSION" ] || stop "VERSION in make_js8map_package.sh is $PKGVER, but the program is $VERSION"

# --- what the build PC needs -----------------------------------------------------
command -v python3 >/dev/null 2>&1 || stop "python3 is missing:  sudo apt install python3"
python3 -c 'import tkinter' 2>/dev/null || stop "Tk is missing:  sudo apt install python3-tk"
python3 -c 'import venv, ensurepip' 2>/dev/null || stop "python3-venv is missing:  sudo apt install python3-venv"
command -v tar >/dev/null 2>&1 || stop "tar is missing"

OUTNAME="JS8Map_Spotter_v${VERSION}_build_${TAG_PY}_linux.tar.gz"
DL="$(xdg-user-dir DOWNLOAD 2>/dev/null || echo "$HOME/Downloads")"
LOG="$APP/output/build_linux.log"
mkdir -p "$APP/output"
: > "$LOG"
say "  log:      $LOG"
say ""

# --- 1. build tools (once) ---------------------------------------------------------
say "[1/3] build tools ..."
if [ ! -x .buildenv/bin/pyinstaller ]; then
    say "      first time: downloading PyInstaller (a few minutes)"
    rm -rf .buildenv
    python3 -m venv .buildenv >>"$LOG" 2>&1 || stop "could not make .buildenv (see $LOG)"
    .buildenv/bin/python -m pip install --quiet --upgrade pip >>"$LOG" 2>&1 || true
    .buildenv/bin/python -m pip install --quiet pyinstaller >>"$LOG" 2>&1 \
        || { rm -rf .buildenv; stop "could not download PyInstaller -- check the internet (see $LOG)"; }
fi
.buildenv/bin/python -c 'import tkinter' 2>/dev/null || { rm -rf .buildenv; stop "the build tools can't see Tk -- run this again"; }
say "      PyInstaller $(.buildenv/bin/pyinstaller --version 2>/dev/null)"

# --- 2. the program --------------------------------------------------------------------
say "[2/3] building the program (1-3 minutes) ..."
rm -rf build dist pkgbuild
PATH="$APP/.buildenv/bin:$PATH" bash build_js8map_linux.sh </dev/null >>"$LOG" 2>&1 \
    || { tail -n 25 "$LOG" >&2; stop "the program build failed (above; full log: $LOG)"; }
[ -x dist/JS8Map ] || stop "the build finished but dist/JS8Map is missing (see $LOG)"
say "      dist/JS8Map  $(du -h dist/JS8Map | cut -f1)"

# --- 3. the package --------------------------------------------------------------------
say "[3/3] packaging ..."
rm -f JS8Map_Spotter_v"${VERSION}"_linux.tar.gz
bash make_js8map_package.sh </dev/null >>"$LOG" 2>&1 \
    || { tail -n 25 "$LOG" >&2; stop "packaging failed (above; full log: $LOG)"; }
[ -f "JS8Map_Spotter_v${VERSION}_linux.tar.gz" ] || stop "packaging finished but the .tar.gz is missing (see $LOG)"
mv -f "JS8Map_Spotter_v${VERSION}_linux.tar.gz" "output/$OUTNAME"

# never ship operator data
if tar -tzf "output/$OUTNAME" | grep -Eq '(^|/)(js8map_request_token\.txt|ham_map_config\.json)$|\.db(-wal|-shm)?$'; then
    rm -f "output/$OUTNAME"; stop "the package contained operator data -- it was deleted"
fi
mkdir -p "$DL" && cp -f "output/$OUTNAME" "$DL/"
rm -rf build pkgbuild

say ""
say "DONE.  The file to send:"
say "  $DL/$OUTNAME  ($(du -h "output/$OUTNAME" | cut -f1))"
say "  (also in $APP/output)"
say "The other station saves it in Downloads and runs:"
say "  tar -C ~/Downloads -xzf ~/Downloads/$OUTNAME"
say "  bash ~/Downloads/JS8Map_Spotter_v${VERSION}_linux/install.sh"
