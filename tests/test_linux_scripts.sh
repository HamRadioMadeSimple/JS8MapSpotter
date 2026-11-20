#!/bin/bash
# test_linux_scripts.sh -- throwaway-home tests for update_linux.sh and
# linux_install.sh (2026-10-29). Nothing outside a temporary folder is touched:
# every case runs with HOME pointed at a fresh fake home.
#
#   bash tests/test_linux_scripts.sh          (from the app folder; needs unzip, zip)
#
# Builds a release zip of THIS folder first (tools/make_release.py --no-tests),
# then checks: install without Tk / with Tk; update from a "Ver 1.2" folder
# keeping config, database and token; same build; older build; a zip with a
# token; Spotter running; a zip that lost its executable marks; both folders
# present; a non-Spotter zip; the shell glob from the guide.
set -u
# Never wait for a key (29c): the scripts answer "no" by themselves, and every
# case below also runs with stdin from /dev/null.
export JS8MAP_ASSUME_NO=1
APP="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/zips" "$T/bin"
python3 "$APP/tools/make_release.py" "$T/zips" --no-tests >/dev/null || { echo "could not build a zip"; exit 1; }
Z="$(ls "$T"/zips/JS8Map_Spotter_Ver_*_build_*.zip | head -n 1)"
VER="$(basename "$(unzip -Z1 "$Z" | head -n 1 | cut -d/ -f1)")"            # "Spotter Mapper Ver X"
TAG="$(unzip -p "$Z" "$VER/js8map_statrep.py" | grep -o "STATREP_BUILD = '[^']*'" | cut -d"'" -f2)"
BASE="$(basename "$Z" .zip)"
# a python that has Tk (for the install case), and one that pretends not to
TKPY=''; for p in python3 python3.12 python3.11 python3.13 python3.10; do
  command -v "$p" >/dev/null 2>&1 && "$p" -c 'import tkinter' 2>/dev/null && { TKPY="$p"; break; }; done
printf '#!/bin/sh\ncase "$*" in *tkinter*) exit 1;; esac\nexec python3 "$@"\n' > "$T/bin/python-notk"; chmod +x "$T/bin/python-notk"
pass=0; fail=0
ok()  { echo "  PASS: $*"; pass=$((pass+1)); }
bad() { echo "  FAIL: $*"; fail=$((fail+1)); }
newhome() { H="$T/home_$1"; rm -rf "$H"; mkdir -p "$H/Downloads" "$H/Desktop"; }

# Build helper zips: no exec marks; with a token; an older build; a Windows one
python3 - "$Z" "$T/zips" "$TAG" "$VER" "$BASE" <<'E'
import sys, zipfile, os
src, out, tag, ver, base = sys.argv[1:6]
def copy(dst, mutate=None, extra=None):
    with zipfile.ZipFile(src) as a, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as b:
        for i in a.infolist():
            data = a.read(i.filename)
            if mutate: i, data = mutate(i, data)
            b.writestr(i, data)
        if extra: b.writestr(*extra)
def nomarks(i, d): i.external_attr = 0; i.create_system = 0; return i, d   # as from Windows
def older(i, d):
    if i.filename.endswith('/js8map_statrep.py'): d = d.replace(("'%s'" % tag).encode(), b"'2026-01-01a'")
    return i, d
copy(os.path.join(out, 'nomarks.zip'), nomarks)
copy(os.path.join(out, 'JS8Map_Spotter_token_build_2026-10-19b.zip'), None, (ver + '/js8map_request_token.txt', 'abc'))
copy(os.path.join(out, 'JS8Map_Spotter_older_build_2026-01-01a.zip'), older)
copy(os.path.join(out, base + '_Windows.zip'))
E

echo "== A. first install, a Python WITHOUT Tk, nobody answers the prompt"
newhome A; mkdir -p "$H/JS8MapSpotter"; unzip -q "$Z" -d "$H/JS8MapSpotter"
out=$(HOME="$H" PYTHON="$T/bin/python-notk" sh "$H/JS8MapSpotter/${VER}/linux_install.sh" </dev/null 2>&1); rc=$?
echo "$out" | grep -q "python3-tk" && [ $rc -ne 0 ] && ok "missing Tk reported, stopped (rc=$rc)" || bad "missing Tk: rc=$rc"
[ ! -f "$H/.local/share/applications/js8map-spotter.desktop" ] && ok "no launcher written when Tk missing" || bad "launcher written anyway"

echo "== B. first install with a Python that has Tk (${TKPY:-none found})"
if [ -z "$TKPY" ]; then echo "  SKIP: no Python with Tk here (sudo apt install python3-tk)"; else
out=$(HOME="$H" PYTHON="$TKPY" sh "$H/JS8MapSpotter/${VER}/linux_install.sh" </dev/null 2>&1); rc=$?
[ $rc -eq 0 ] && ok "install finished" || bad "install rc=$rc: $out"
grep -q "${VER}/debug.sh" "$H/.local/share/applications/js8map-spotter.desktop" && ok "menu entry points at the folder" || bad "menu entry"
[ -f "$H/Desktop/JS8Map-Spotter.desktop" ] && ok "desktop icon made" || bad "no desktop icon"
echo "$out" | grep -q "update_linux.sh" && ok "update command shown" || bad "no update hint"
fi

echo "== C. update from a 'Ver 1.2' folder that holds the operator's data"
newhome C; mkdir -p "$H/JS8MapSpotter"; unzip -q "$Z" -d "$H/JS8MapSpotter"
OLD="$H/JS8MapSpotter/Spotter Mapper Ver 1.2"; mv "$H/JS8MapSpotter/${VER}" "$OLD"
sed -i "s/'${TAG}'/'2026-10-19c'/" "$OLD/js8map_statrep.py"
echo '{"callsign":"KW3KW"}' > "$OLD/ham_map_config.json"; echo data > "$OLD/js8_spots.db"; echo mytoken > "$OLD/js8map_request_token.txt"
HOME="$H" sh "$OLD/tools/install_linux_launcher.sh" >/dev/null
cp "$Z" "$H/Downloads/"; sleep 1; cp "$T/zips/${BASE}_Windows.zip" "$H/Downloads/"   # newer, but Windows
out=$(HOME="$H" sh "$OLD/update_linux.sh" </dev/null 2>&1); rc=$?
N="$H/JS8MapSpotter/${VER}"
[ $rc -eq 0 ] && ok "update finished" || bad "update rc=$rc: $out"
echo "$out" | grep -q "_Windows" && bad "picked the Windows zip" || ok "ignored the newer _Windows zip"
[ -d "$N" ] && [ ! -e "$OLD" ] && ok "folder renamed Ver 1.2 -> ${VER#Spotter Mapper }" || bad "rename"
[ "$(cat "$N/ham_map_config.json")" = '{"callsign":"KW3KW"}' ] && [ -f "$N/js8_spots.db" ] && [ "$(cat "$N/js8map_request_token.txt")" = mytoken ] && ok "settings, database and own token kept" || bad "data lost"
grep -q "'${TAG}'" "$N/js8map_statrep.py" && ok "now build ${TAG}" || bad "build"
grep -q "${VER}/debug.sh" "$H/.local/share/applications/js8map-spotter.desktop" && grep -q "${VER}" "$H/Desktop/JS8Map-Spotter.desktop" && ok "menu + desktop icon re-pointed" || bad "launchers not re-pointed"
echo "$out" | grep -q "19c  ->  ${TAG}" && ok "shows old -> new build" || bad "build line: $(echo "$out" | grep build)"

echo "== D. same build again (refresh)"
out=$(HOME="$H" sh "$N/update_linux.sh" </dev/null 2>&1); rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "same build" && ok "same-build refresh ok" || bad "same build rc=$rc"

echo "== E. older zip, nobody answers -> no change"
out=$(HOME="$H" sh "$N/update_linux.sh" "$T/zips/JS8Map_Spotter_older_build_2026-01-01a.zip" </dev/null 2>&1); rc=$?
grep -q "'${TAG}'" "$N/js8map_statrep.py" && echo "$out" | grep -q "OLDER" && ok "older zip not installed without a yes" || bad "older: $out"

echo "== F. zip with a request token (like 19a/19b) is refused"
out=$(HOME="$H" sh "$N/update_linux.sh" "$T/zips/JS8Map_Spotter_token_build_2026-10-19b.zip" </dev/null 2>&1); rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q "operator data" && [ "$(cat "$N/js8map_request_token.txt")" = mytoken ] && ok "refused, own token untouched" || bad "token zip: rc=$rc $out"

echo "== G. Spotter running from this folder -> stop"
(cd "$N" && exec -a python3 python3 -c "import time; time.sleep(30)" JS8Map.py) & P=$!; sleep 1
out=$(HOME="$H" sh "$N/update_linux.sh" </dev/null 2>&1); rc=$?; kill $P 2>/dev/null; wait $P 2>/dev/null
[ $rc -ne 0 ] && echo "$out" | grep -q "is running" && ok "refused while running" || bad "running: rc=$rc $out"

echo "== H. zip that lost its executable marks (made on Windows)"
cp "$T/zips/nomarks.zip" "$H/Downloads/${BASE} (1).zip"
chmod -x "$N/debug.sh"
out=$(HOME="$H" sh "$N/update_linux.sh" </dev/null 2>&1); rc=$?
[ $rc -eq 0 ] && [ -x "$N/debug.sh" ] && [ -x "$N/update_linux.sh" ] && ok "marks restored (picked the '(1)' copy)" || bad "marks: rc=$rc $(ls -l "$N/debug.sh")"

echo "== I. both 'Ver 1.2' and '${VER}' folders exist -> stop"
newhome I; mkdir -p "$H/JS8MapSpotter"; unzip -q "$Z" -d "$H/JS8MapSpotter"
cp -a "$H/JS8MapSpotter/${VER}" "$H/JS8MapSpotter/Spotter Mapper Ver 1.2"
out=$(HOME="$H" sh "$H/JS8MapSpotter/Spotter Mapper Ver 1.2/update_linux.sh" "$Z" </dev/null 2>&1); rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q "both" && ok "refused, asks which folder holds the settings" || bad "both: rc=$rc"

echo "== J. not a Spotter zip"
echo x > "$T/x.txt"; (cd "$T" && zip -q junk.zip x.txt)
out=$(HOME="$H" sh "$H/JS8MapSpotter/${VER}/update_linux.sh" "$T/junk.zip" </dev/null 2>&1); rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q "not a JS8Map Spotter zip" && ok "junk zip refused" || bad "junk: $out"

echo "== K. run with the shell glob from the guide"
out=$(cd /; HOME="$H" sh -c 'sh "$HOME"/JS8MapSpotter/Spotter*/update_linux.sh' 2>&1 </dev/null); rc=$?
echo "$out" | grep -q "both\|ignoring" && ok "glob with two folders: stops cleanly ($(echo "$out" | grep -c ignoring) ignored)" || bad "glob: $out"

echo "== L. run from a BUILD folder, nothing installed -> first install (29c)"
newhome L; B="$T/build_L"; rm -rf "$B"; mkdir -p "$B"; unzip -q "$Z" -d "$B"
cp "$Z" "$H/Downloads/"
if [ -z "$TKPY" ]; then echo "  SKIP: no Python with Tk here"; else
out=$(HOME="$H" PYTHON="$TKPY" sh "$B/${VER}/update_linux.sh" </dev/null 2>&1); rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q "first install" && ok "first install from a build folder" || bad "first install: rc=$rc $out"
[ -f "$H/JS8MapSpotter/${VER}/JS8Map.py" ] && ok "installed into ~/JS8MapSpotter" || bad "not installed in ~/JS8MapSpotter"
grep -q "Path=$H/JS8MapSpotter/${VER}" "$H/.local/share/applications/js8map-spotter.desktop" 2>/dev/null && ok "menu entry points at the installed copy, not the build folder" || bad "menu entry"
fi
out=$(HOME="$H" PYTHON="$T/bin/python-notk" sh "$B/${VER}/update_linux.sh" </dev/null 2>&1); rc=$?   # again: now it is an update
echo "$out" | grep -q "first install" && bad "second run did a first install again" || ok "second run from the build folder is an update"

echo "== M. run from a BUILD folder, Spotter installed elsewhere -> updates the installed copy (29c)"
newhome M; mkdir -p "$H/JS8MapSpotter"; unzip -q "$Z" -d "$H/JS8MapSpotter"
I="$H/JS8MapSpotter/${VER}"; sed -i "s/'${TAG}'/'2026-10-19c'/" "$I/js8map_statrep.py"
echo '{"callsign":"KW3KW"}' > "$I/ham_map_config.json"; echo mytoken > "$I/js8map_request_token.txt"
HOME="$H" sh "$I/tools/install_linux_launcher.sh" >/dev/null
B="$T/build_M"; rm -rf "$B"; mkdir -p "$B"; unzip -q "$Z" -d "$B"; cp "$Z" "$H/Downloads/"
out=$(HOME="$H" sh "$B/${VER}/update_linux.sh" </dev/null 2>&1); rc=$?
[ $rc -eq 0 ] && grep -q "'${TAG}'" "$I/js8map_statrep.py" && ok "installed copy updated to ${TAG}" || bad "update from build folder: rc=$rc $out"
[ "$(cat "$I/js8map_request_token.txt")" = "mytoken" ] && [ -f "$I/ham_map_config.json" ] && ok "settings and token kept" || bad "settings lost"
grep -q "Path=$B" "$H/.local/share/applications/js8map-spotter.desktop" && bad "menu entry moved to the build folder" || ok "menu entry still points at the installed copy"

echo; echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
