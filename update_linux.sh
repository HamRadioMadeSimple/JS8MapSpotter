#!/bin/sh
# update_linux.sh -- update JS8Map Spotter on Linux with one command.
#
#   sh ~/JS8MapSpotter/Spotter*/update_linux.sh              newest zip in ~/Downloads
#   sh ~/JS8MapSpotter/Spotter*/update_linux.sh FILE.zip     a particular zip
#   sh update_linux.sh                (from ANY copy, e.g. a build folder -- 29c)
#
# Which Spotter it updates (29c):
#   - run from the installed copy (a "Spotter Mapper Ver x" folder directly in
#     ~/JS8MapSpotter): that copy, as before;
#   - run from anywhere else: the installed copy -- the folder the menu entry
#     points at, else the one Spotter folder in ~/JS8MapSpotter;
#   - nothing installed yet: a FIRST INSTALL into ~/JS8MapSpotter, then
#     linux_install.sh (Python/Tk check, menu entry, desktop icon).
#   JS8MAP_INSTALL_DIR overrides ~/JS8MapSpotter.
#
# What it does (2026-10-29):
#   1. picks the zip: the one you name, or the NEWEST
#      JS8Map_Spotter_Ver_*_build_*.zip in ~/Downloads (a "_Windows" zip is
#      never picked); shows the current and the new build;
#   2. refuses a zip that carries operator data (a request token, settings or
#      databases -- e.g. the withdrawn 19a/19b zips);
#   3. stops if Spotter is running from this folder (close it first);
#   4. if the version changed, renames this folder to the zip's folder name
#      ("Spotter Mapper Ver 1.2" -> "Spotter Mapper Ver 1.76"), so your
#      settings and databases move with it;
#   5. unzips over the folder (your settings and databases are not in the zip,
#      so they are kept), restores the "executable" marks a Windows PC may
#      have dropped, and re-points the menu entry and desktop icon.
#
# Always start it with "sh", as above: that works even when the file is not
# marked executable. Run it from anywhere. JS8Map 1.75 is never touched.
set -e

say()  { printf '%s\n' "$*"; }
stop() { printf '\nSTOP: %s\nNothing was changed.\n' "$*" >&2; exit 1; }
ask()  {   # ask "question" -> 0 for yes. No terminal -> no.
    printf '%s [y/N] ' "$1"
    # Only ask a person at a terminal (29c). Run by a test or a script
    # (stdin not a terminal), or with JS8MAP_ASSUME_NO=1: the answer is no,
    # at once -- it never waits for a key nobody can see.
    a=''
    if [ -z "${JS8MAP_ASSUME_NO:-}" ] && [ -t 0 ]; then read -r a || a=''; else printf '(no)\n'; fi
    case "$a" in [Yy]|[Yy][Ee][Ss]) return 0 ;; *) return 1 ;; esac
}

SELF="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SELF/JS8Map.py" ] || stop "this copy of update_linux.sh is not in a Spotter folder ($SELF)."
command -v unzip >/dev/null 2>&1 || stop "the 'unzip' program is missing:  sudo apt install unzip"

# --- 0. which installed Spotter (29c) ----------------------------------------------
IROOT="${JS8MAP_INSTALL_DIR:-$HOME/JS8MapSpotter}"
[ -d "$IROOT" ] && IROOT="$(cd "$IROOT" && pwd)"
FIRST=''
if [ "$(dirname "$SELF")" = "$IROOT" ]; then
    TARGET="$SELF"                                   # run from the installed copy
else
    TARGET=''
    MENU="$HOME/.local/share/applications/js8map-spotter.desktop"
    if [ -f "$MENU" ]; then
        P="$(sed -n 's/^Path=//p' "$MENU" | head -n 1)"
        [ -n "$P" ] && [ -f "$P/JS8Map.py" ] && [ "$P" != "$SELF" ] && TARGET="$P"
    fi
    if [ -z "$TARGET" ]; then
        n=0
        for d in "$IROOT"/"Spotter Mapper Ver "*; do
            [ -f "$d/JS8Map.py" ] || continue
            n=$((n + 1)); TARGET="$d"
        done
        [ "$n" -le 1 ] || stop "there is more than one Spotter folder in $IROOT.
      Keep the one with your settings (it has ham_map_config.json), rename or
      remove the other, and run this again."
    fi
    [ "$TARGET" = "$SELF" ] && TARGET=''
    if [ -z "$TARGET" ]; then FIRST=1; fi
fi
if [ -n "$FIRST" ]; then
    ROOT="$IROOT"; NAME=''
else
    ROOT="$(dirname "$TARGET")"; NAME="$(basename "$TARGET")"
fi

# --- 1. which zip --------------------------------------------------------------
ZIP=''
for a in "$@"; do
    case "$a" in *.zip) ZIP="$a" ;; *) say "(ignoring '$a')" ;; esac
done
if [ -z "$ZIP" ]; then
    DL="$(xdg-user-dir DOWNLOAD 2>/dev/null || echo "$HOME/Downloads")"
    # newest first; zip names never contain newlines, so ls | grep is safe here
    # shellcheck disable=SC2010
    ZIP="$(ls -t "$DL"/JS8Map_Spotter_Ver_*_build_*.zip 2>/dev/null | grep -v '_Windows' | head -n 1 || true)"
    [ -n "$ZIP" ] || stop "no JS8Map_Spotter_Ver_..._build_....zip found in $DL
      Save the new zip there, or name it:  sh $0 /path/to/the.zip"
fi
[ -f "$ZIP" ] || stop "file not found: $ZIP"

NEW="$(unzip -Z1 "$ZIP" 2>/dev/null | head -n 1 | cut -d/ -f1)"
case "$NEW" in
    "Spotter Mapper Ver "*) ;;
    *) stop "$ZIP is not a JS8Map Spotter zip (its folder is '$NEW')." ;;
esac
if unzip -Z1 "$ZIP" | grep -Eq '(^|/)(js8map_request_token\.txt|ham_map_config\.json)$|\.db(-wal|-shm)?$'; then
    stop "$ZIP contains operator data (a request token, settings or a database).
      Do not install it. Use a newer build."
fi

tag_of() { grep -o "STATREP_BUILD = '[^']*'" 2>/dev/null | cut -d"'" -f2; }
OLD_TAG=''
[ -n "$FIRST" ] || OLD_TAG="$(tag_of < "$TARGET/js8map_statrep.py" || true)"
NEW_TAG="$(unzip -p "$ZIP" "$NEW/js8map_statrep.py" 2>/dev/null | tag_of || true)"
[ -n "$NEW_TAG" ] || stop "could not read the build tag inside $ZIP (incomplete download?)"

if [ -n "$FIRST" ]; then
    say "JS8Map Spotter -- first install (not installed on this PC yet)"
    say "  zip:      $ZIP"
    say "  folder:   $ROOT/$NEW"
    say "  build:    $NEW_TAG"
    mkdir -p "$ROOT" || stop "can't make $ROOT"
    [ -e "$ROOT/$NEW" ] && stop "$ROOT/$NEW already exists but is not a Spotter folder. Move it away and run this again."
    unzip -o -q "$ZIP" -d "$ROOT"
    chmod +x "$ROOT/$NEW/debug.sh" "$ROOT/$NEW/update_linux.sh" "$ROOT/$NEW/linux_install.sh" \
             "$ROOT/$NEW"/tools/*.sh 2>/dev/null || true
    say ""
    sh "$ROOT/$NEW/linux_install.sh" || stop "the setup step stopped (reason above). The program is unzipped in
      $ROOT/$NEW
      -- fix what it says, then run:  sh \"$ROOT/$NEW/linux_install.sh\""
    say ""
    say "DONE. JS8Map Spotter build $NEW_TAG is installed in:"
    say "  $ROOT/$NEW"
    say "Later updates:  sh ~/JS8MapSpotter/Spotter*/update_linux.sh"
    exit 0
fi

say "JS8Map Spotter update"
say "  zip:      $ZIP"
say "  folder:   $TARGET"
[ "$TARGET" = "$SELF" ] || say "  (run from $SELF)"
say "  build:    ${OLD_TAG:-?}  ->  $NEW_TAG"
[ "$NAME" = "$NEW" ] || say "  rename:   '$NAME'  ->  '$NEW'"
if [ "$NEW_TAG" = "$OLD_TAG" ]; then
    say "  (same build -- the files will be refreshed)"
elif [ -n "$OLD_TAG" ] && [ "$(printf '%s\n%s\n' "$OLD_TAG" "$NEW_TAG" | sort | tail -n 1)" = "$OLD_TAG" ]; then
    ask "  The zip is OLDER than what is installed. Go back to it?" || { say "Nothing was changed."; exit 0; }
fi

# --- 3. not while it is running from this folder ----------------------------------
for pid in $(pgrep -f 'JS8Map\.py' 2>/dev/null || true); do
    if [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$TARGET" ]; then
        stop "JS8Map Spotter is running from this folder (process $pid).
      Close it and its map window, then run this again."
    fi
done

# --- 4. rename on a version change ----------------------------------------------
cd "$ROOT"
DEST="$ROOT/$NEW"
if [ "$NAME" != "$NEW" ]; then
    [ -e "$DEST" ] && stop "both '$NAME' and '$NEW' exist in $ROOT.
      Keep the one with your settings (it has ham_map_config.json), rename or
      remove the other, and run this again."
    mv "$TARGET" "$DEST"
    say "Renamed the folder to '$NEW' (settings and databases moved with it)."
fi

# --- 5. unzip over it, fix the marks, re-point the launchers -----------------------
unzip -o -q "$ZIP" -d "$ROOT"
chmod +x "$DEST/debug.sh" "$DEST/update_linux.sh" "$DEST/linux_install.sh" \
         "$DEST"/tools/*.sh 2>/dev/null || true
sh "$DEST/tools/install_linux_launcher.sh" >/dev/null
GOT="$(tag_of < "$DEST/js8map_statrep.py" || true)"

say ""
say "DONE. JS8Map Spotter is now build $GOT in:"
say "  $DEST"
say "The menu entry and desktop icon point there. Start Spotter from the icon;"
say "the bottom of the StatReps box on the map should say \"build $GOT\"."
say "If Spotter was open, close it and its map window, start it again and click"
say "Generate Map (F5 alone can keep an old page)."
