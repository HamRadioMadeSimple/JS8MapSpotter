#!/bin/sh
# build_release.sh -- make a JS8Map Spotter release zip in ONE command (29c).
#
#   sh tools/build_release.sh            (from the program folder; zip goes to ~/Downloads)
#   sh tools/build_release.sh <folder>   (zip goes to <folder> instead)
#
# It never asks a question and never waits for a key. In order, it:
#   1. checks it is in a "JS8Map Spotter V<x>" folder and that python3,
#      unzip and bash are present;
#   2. shows the version and the two build tags (STATREP_BUILD in
#      js8map_statrep.py, SR_PAGE_BUILD in app.js) and stops if they differ;
#   3. stops if a zip with this build tag is already in the output folder
#      (two builds with the same tag can't be told apart -- raise the letter);
#   4. runs the unit tests;
#   5. runs the 28 Linux script tests (in throwaway home folders, answers "no" to
#      every prompt, stopped after 10 minutes if anything ever hangs);
#   6. makes the zip with tools/make_release.py, which leaves out your own
#      settings, databases and request token and refuses if any got in.
# Any failure stops it with STOP: and the reason; nothing is half-made.
# Settings, databases and the installed Spotter are never touched.
set -eu

say()  { printf '%s\n' "$*"; }
stop() { printf '\nSTOP: %s\nNo zip was made.\n' "$*" >&2; exit 1; }

APP="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP"
OUT="${1:-$HOME/Downloads}"
export JS8MAP_ASSUME_NO=1          # the install/update scripts never prompt

# --- 1. where and what --------------------------------------------------------
[ -f JS8Map.py ] && [ -f tools/make_release.py ] || stop "run this inside the program folder:
      cd ~/build/spotter/\"JS8Map Spotter V1.76\" && sh tools/build_release.sh"
for c in python3 unzip bash; do
    command -v "$c" >/dev/null 2>&1 || stop "'$c' is missing:  sudo apt install $c"
done
mkdir -p "$OUT" 2>/dev/null || stop "can't use the output folder $OUT"

# --- 2. version and build tags ------------------------------------------------
VERSION="$(sed -n "s/^APP_VERSION *= *['\"]\([^'\"]*\)['\"].*/\1/p" js8map_runtime.py | head -n 1)"
TAG_PY="$(sed -n "s/^STATREP_BUILD *= *'\([^']*\)'.*/\1/p" js8map_statrep.py | head -n 1)"
TAG_JS="$(sed -n "s/^const SR_PAGE_BUILD *= *'\([^']*\)'.*/\1/p" app.js | head -n 1)"
say "JS8Map Spotter release build"
say "  folder:   $APP"
say "  version:  ${VERSION:-?}"
say "  build:    js8map_statrep.py ${TAG_PY:-?}   app.js ${TAG_JS:-?}"
say "  zip to:   $OUT"
[ -n "$VERSION" ] && [ -n "$TAG_PY" ] && [ -n "$TAG_JS" ] || stop "could not read the version or a build tag"
[ "$TAG_PY" = "$TAG_JS" ] || stop "the two build tags differ -- make them the same:
      STATREP_BUILD in js8map_statrep.py and SR_PAGE_BUILD in app.js"
[ "$(basename "$APP")" = "JS8Map Spotter V$VERSION" ] || stop "the folder must be named \"JS8Map Spotter V$VERSION\" (it is \"$(basename "$APP")\")"

# --- 3. same tag already built? -----------------------------------------------
for z in "$OUT"/JS8Map_Spotter_Ver_*_build_"$TAG_PY"*.zip; do
    [ -e "$z" ] || continue
    stop "a zip for build $TAG_PY is already in $OUT:
      $(basename "$z")
      Raise the letter in BOTH files (e.g. ${TAG_PY%?}<next letter>), or delete that zip if it was a failed try."
done

# --- 4. unit tests --------------------------------------------------------------
say ""; say "[1/3] unit tests ..."
python3 -m unittest discover -s tests </dev/null >"$OUT/.spotter_unit.log" 2>&1 \
    || { tail -n 30 "$OUT/.spotter_unit.log" >&2; rm -f "$OUT/.spotter_unit.log"; stop "unit tests failed (above)"; }
say "      $(grep -E '^Ran [0-9]+ tests' "$OUT/.spotter_unit.log")  OK"
rm -f "$OUT/.spotter_unit.log"

# --- 5. Linux script tests ------------------------------------------------------
say "[2/3] Linux script tests (about a minute) ..."
if command -v timeout >/dev/null 2>&1; then T="timeout 600"; else T=""; fi
set +e
$T bash tests/test_linux_scripts.sh </dev/null >"$OUT/.spotter_scripts.log" 2>&1
rc=$?
set -e
SUM="$(grep -E '^passed [0-9]+, failed [0-9]+' "$OUT/.spotter_scripts.log" | tail -n 1)"
if [ "$rc" -ne 0 ] || [ -z "$SUM" ] || ! printf '%s' "$SUM" | grep -q 'failed 0$'; then
    grep -E 'FAIL|SKIP|could not' "$OUT/.spotter_scripts.log" >&2 || tail -n 20 "$OUT/.spotter_scripts.log" >&2
    rm -f "$OUT/.spotter_scripts.log"
    [ "$rc" -eq 124 ] && stop "the Linux script tests took over 10 minutes and were stopped"
    stop "Linux script tests failed (above)"
fi
grep -q 'SKIP' "$OUT/.spotter_scripts.log" && say "      note: $(grep 'SKIP' "$OUT/.spotter_scripts.log" | head -n 1 | sed 's/^ *//')"
say "      $SUM"
rm -f "$OUT/.spotter_scripts.log"

# --- 6. the zip -----------------------------------------------------------------
say "[3/3] making the zip ..."
python3 tools/make_release.py "$OUT" --no-tests </dev/null || stop "make_release.py refused (reason above)"
ZIP="$OUT/JS8Map_Spotter_Ver_${VERSION}_build_${TAG_PY}.zip"
[ -f "$ZIP" ] || stop "make_release.py finished but $ZIP is not there"

say ""
say "DONE.  $ZIP"
say "  Install it on this PC (close Spotter first). This works whether or not"
say "  Spotter is installed yet, and keeps your settings:"
say "      sh update_linux.sh \"$ZIP\""
say "  Then start Spotter, Generate Map, and check the StatReps box says \"build $TAG_PY\"."
