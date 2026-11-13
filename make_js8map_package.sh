#!/bin/bash
# ============================================================================
#  make_js8map_package.sh
#
#  Makes the shippable Linux package for JS8Map Spotter.
#
#  Spotter is a SEPARATE product from JS8Map 1.75 (operator, 2026-10-17):
#  it installs to ~/Applications/JS8Map_Spotter_v<x>_linux (2026-11-02; was
#  ~/.local/lib/JS8MapSpotter, which the installer now offers to remove) with
#  its own menu files (js8map-spotter*.desktop) and keeps its data in
#  ~/.local/share/JS8Map Spotter, so an installed JS8Map 1.75 (~/.local/lib/JS8Map,
#  js8map.desktop) is never touched. The program file keeps its name, JS8Map. (17g)
#
#  Run this on the BUILD machine, from the project folder, AFTER a successful
#  ./build_js8map_linux.sh
#
#  Output:  JS8Map_Spotter_v1.76_linux.tar.gz   in the project folder
#
#  That single .tar.gz is what goes to another Linux operator. They save it in
#  Downloads and paste three lines (see README-INSTALL.txt below), which unpack
#  it into ~/Applications and run install.sh there. No root, no sudo.
# ============================================================================

set -e

VERSION="1.76"
PKGNAME="JS8Map_Spotter_v${VERSION}_linux"

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"
STAGE="${PROJECT_DIR}/pkgbuild/${PKGNAME}"

echo "============================================================"
echo " JS8Map Spotter ${VERSION} Linux package builder"
echo " Project folder: ${PROJECT_DIR}"
echo "============================================================"
echo ""

# ---------------------------------------------------------------------------
# 1. The built program must exist
# ---------------------------------------------------------------------------
if [ ! -f "${PROJECT_DIR}/dist/JS8Map" ]; then
    echo "STOP: dist/JS8Map was not found."
    echo "      Build it first:  ./build_js8map_linux.sh"
    exit 1
fi
echo "Found the built program: dist/JS8Map"

# ---------------------------------------------------------------------------
# 2. All six map files must already be beside it in dist/
#    A missing one here gives a BLANK map on the operator's machine, so this
#    is checked before anything is packed, not after.
# ---------------------------------------------------------------------------
MAPFILES="leaflet.js leaflet.css js8map_borders.json js8map_admin1.json js8map_lakes.json js8map_places.json"

MISSING=""
for f in $MAPFILES; do
    if [ ! -f "${PROJECT_DIR}/dist/${f}" ]; then
        MISSING="${MISSING} ${f}"
    fi
done

if [ -n "$MISSING" ]; then
    echo ""
    echo "STOP: these map files are missing from dist/ :"
    for f in $MISSING; do echo "        ${f}"; done
    echo ""
    echo "      Re-run ./build_js8map_linux.sh and check its last lines."
    exit 1
fi
echo "Found all six map files in dist/"

# ---------------------------------------------------------------------------
# 2b. build_canadian_db.py must be packed too.
#     js8map_fcc.py runs this script to build the Canadian half of ham.db, and
#     it looks for it beside the executable (_EXE_DIR). On Windows JS8Map.iss
#     ships it to {app}; nothing was doing the equivalent here, so the wizard's
#     Canadian step failed on every Linux install -- and the wizard reports the
#     failure as "Download failed", so it looked like a network fault. Checked
#     before packing, like the map files, because a miss is invisible until an
#     operator reaches step 2 of the wizard.
# ---------------------------------------------------------------------------
if [ ! -f "${PROJECT_DIR}/build_canadian_db.py" ]; then
    echo ""
    echo "STOP: build_canadian_db.py was not found in ${PROJECT_DIR}"
    echo "      Without it the Canadian database step cannot work on the"
    echo "      operator's machine. Nothing has been packaged."
    exit 1
fi
echo "Found the Canadian database builder: build_canadian_db.py"

# ---------------------------------------------------------------------------
# 3. The icon: Spotter's own logo first. (JS8Map.desktop is a personal
#    launcher pointing at JS8Map 1.75's folder -- its icon is the OLD logo.)
# ---------------------------------------------------------------------------
ICON_SRC=""

if [ -z "$ICON_SRC" ]; then
    for guess in "${PROJECT_DIR}/JS8Map_icon.png" "${PROJECT_DIR}/js8map.png" \
                 "${PROJECT_DIR}/JS8Map.png" "${PROJECT_DIR}/icon.png" \
                 "${PROJECT_DIR}/assets/js8map.png" "${PROJECT_DIR}/icons/js8map.png"; do
        if [ -f "$guess" ]; then
            ICON_SRC="$guess"
            break
        fi
    done
fi

if [ -n "$ICON_SRC" ]; then
    echo "Found the icon: ${ICON_SRC}"
else
    echo "NOTE: no icon file found. The package will still build and install,"
    echo "      but the launcher will show a generic icon."
fi

# ---------------------------------------------------------------------------
# 4. Stage everything
# ---------------------------------------------------------------------------
rm -rf "${PROJECT_DIR}/pkgbuild"
mkdir -p "${STAGE}"

cp "${PROJECT_DIR}/dist/JS8Map" "${STAGE}/JS8Map"
chmod 755 "${STAGE}/JS8Map"

for f in $MAPFILES; do
    cp "${PROJECT_DIR}/dist/${f}" "${STAGE}/${f}"
done

cp "${PROJECT_DIR}/build_canadian_db.py" "${STAGE}/build_canadian_db.py"

if [ -n "$ICON_SRC" ]; then
    cp "$ICON_SRC" "${STAGE}/js8map-spotter.png"
fi

# ---------------------------------------------------------------------------
# 5. Write install.sh into the package
#
#    Installs into the operator's own home folder:
#        ~/.local/lib/JS8MapSpotter/
#    No root. Writable. The six map files land BESIDE the executable there,
#    which is the same arrangement JS8Map.iss makes on Windows.
# ---------------------------------------------------------------------------
cat > "${STAGE}/install.sh" <<'INSTALL_EOF'
#!/bin/bash
# ============================================================================
#  JS8Map Spotter installer for Linux
#  Installs ALONGSIDE JS8Map 1.75 and never changes it.
#
#  The standard way, in a terminal:
#    F="$(ls -t ~/Downloads/JS8Map_Spotter_*_linux.tar.gz | head -n 1)"
#    mkdir -p ~/Applications && tar -xzf "$F" -C ~/Applications
#    bash ~/Applications/"$(tar -tzf "$F" | head -n 1 | cut -d/ -f1)"/install.sh
#  A newer version installs with the same three lines. The last line runs the
#  installer in the folder just unpacked, never a guess with *, which would
#  pick an older version sitting beside it.
#
#  The program runs from the folder it was unpacked into. ~/Applications is the
#  standard place for every JS8MapChat app; another folder works too.
#  No root and no sudo needed. Nothing is written outside your home folder.
#  Your settings and databases are in ~/.local/share/JS8Map Spotter, never in
#  the program folder, so installing, updating or removing keeps them.
# ============================================================================

set -e

APPDIR="$(cd "$(dirname "$0")" && pwd)"
PARENT="$(dirname "${APPDIR}")"
MENUDIR="${HOME}/.local/share/applications"
DESKDIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "${HOME}/Desktop")"
OLDLIB="${HOME}/.local/lib/JS8MapSpotter"

MAPFILES="leaflet.js leaflet.css js8map_borders.json js8map_admin1.json js8map_lakes.json js8map_places.json"

DATADIR="${XDG_DATA_HOME:-${HOME}/.local/share}/JS8Map Spotter"

ask () {   # ask "question" -> 0 for yes. No terminal -> no.
    printf '%s [y/N] ' "$1"
    a=''; { read -r a < /dev/tty; } 2>/dev/null || a=''
    case "$a" in [Yy]|[Yy][Ee][Ss]) return 0 ;; *) return 1 ;; esac
}

echo "============================================================"
echo " Installing JS8Map Spotter"
echo "   folder: ${APPDIR}"
echo "============================================================"
echo ""

# --- never run from inside the app's own data folder ------------------------
if [ "${APPDIR}" = "${DATADIR}" ]; then
    echo "STOP: this folder is Spotter's data folder."
    echo "      Unpack the .tar.gz into ~/Applications instead."
    echo "      Nothing has been installed."
    exit 1
fi
for marker in ham_map_config.json js8_spots.db js8_relay.db map_window_profile; do
    if [ -e "${APPDIR}/${marker}" ]; then
        echo "STOP: ${APPDIR}"
        echo "      holds JS8Map settings or databases, so it is not a fresh package."
        echo "      Unpack the .tar.gz into ~/Applications instead."
        echo "      Nothing has been installed."
        exit 1
    fi
done

# --- check the package is complete before touching anything -----------------
if [ ! -f "${APPDIR}/JS8Map" ]; then
    echo "STOP: the JS8Map program is missing from this folder."
    echo "      Unpack the whole .tar.gz and run install.sh from inside it."
    exit 1
fi

MISSING=""
for f in $MAPFILES build_canadian_db.py; do
    # build_canadian_db.py: the Canadian step of the first-run wizard runs it,
    # and looks for it beside the program.
    [ -f "${APPDIR}/${f}" ] || MISSING="${MISSING} ${f}"
done
if [ -n "$MISSING" ]; then
    echo "STOP: this package is incomplete. Missing:"
    for f in $MISSING; do echo "        ${f}"; done
    echo "      Nothing has been installed."
    exit 1
fi

# The executable mark can be lost if the package went through a zip.
chmod 755 "${APPDIR}/JS8Map" "${APPDIR}/install.sh" "${APPDIR}/uninstall.sh" 2>/dev/null || true

# --- older copies -------------------------------------------------------------
# Never while Spotter is running: its program file would vanish under it.
if pgrep -x JS8Map >/dev/null 2>&1; then
    RUNNING=1
else
    RUNNING=0
fi

ver_of () {   # JS8Map_Spotter_v1.76_linux -> 1.76
    basename "$1" | sed -n 's/^JS8Map_Spotter_v\(.*\)_linux$/\1/p'
}
MY_VER="$(ver_of "${APPDIR}")"

remove_old () {   # remove_old FOLDER -- only ever an OLDER Spotter program folder
    OLD="$1"
    [ -f "${OLD}/JS8Map" ] || return 0
    [ "${OLD}" = "${APPDIR}" ] && return 0
    V="$(ver_of "${OLD}")"
    if [ -n "$V" ] && [ -n "$MY_VER" ] \
       && [ "$(printf '%s\n%s\n' "$V" "$MY_VER" | sort -V | tail -n 1)" = "$V" ]; then
        echo ""
        echo "  Left alone, it is the same or newer: ${OLD}"
        return 0
    fi
    for marker in ham_map_config.json js8_spots.db js8_relay.db; do
        [ -e "${OLD}/${marker}" ] && return 0    # holds data: leave it alone
    done
    echo ""
    echo "  An older JS8Map Spotter is in: ${OLD}"
    if [ "$RUNNING" = 1 ]; then
        echo "  Kept, because JS8Map Spotter is running. Close it and run this again"
        echo "  to remove it. It is harmless; the menu entry points here instead."
        return 0
    fi
    if ask "  Remove it? (your settings are kept)"; then
        rm -rf "${OLD}" && echo "  Removed."
    else
        echo "  Kept. It is harmless; the menu entry points here instead."
    fi
}
# 1.76 and earlier installed by copying into ~/.local/lib/JS8MapSpotter
remove_old "${OLDLIB}"
# earlier versions unpacked beside this one, e.g. JS8Map_Spotter_v1.75_linux
for d in "${PARENT}"/JS8Map_Spotter_v*_linux; do
    [ -d "$d" ] && remove_old "$d"
done

ICON_LINE=""
if [ -f "${APPDIR}/js8map-spotter.png" ]; then
    ICON_LINE="Icon=${APPDIR}/js8map-spotter.png"
fi

# --- build the launcher -----------------------------------------------------
make_launcher () {
    TARGET="$1"
    cat > "${TARGET}" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=JS8Map Spotter
GenericName=JS8Call Map
Comment=StatReps, MCForms and QSOs heard on JS8Call, on a map
Exec="${APPDIR}/JS8Map"
Path=${APPDIR}
${ICON_LINE}
Terminal=false
Categories=Network;HamRadio;
StartupNotify=true
StartupWMClass=Js8mapspotter
DESKTOP_EOF
    chmod +x "${TARGET}"
}

# applications menu -- Spotter's OWN file names (same as
# tools/install_linux_launcher.sh). JS8Map 1.75's js8map.desktop is left alone.
# Writing them again re-points them at this folder, which is how an update
# moves the menu entry to the new version.
mkdir -p "${MENUDIR}"
make_launcher "${MENUDIR}/js8map-spotter.desktop"

# hidden entry for the map window, so the taskbar shows the sharp logo
# (Chromium gives --app windows only a 16 px page icon)
cat > "${MENUDIR}/js8map-spotter-map.desktop" <<MAP_EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=JS8Map Spotter Map
Exec="${APPDIR}/JS8Map"
${ICON_LINE}
NoDisplay=true
StartupWMClass=127.0.0.1__ham_map.html
MAP_EOF
chmod +x "${MENUDIR}/js8map-spotter-map.desktop"

# desktop icon
if [ -d "${DESKDIR}" ]; then
    make_launcher "${DESKDIR}/JS8Map-Spotter.desktop"
    gio set "${DESKDIR}/JS8Map-Spotter.desktop" metadata::trusted true 2>/dev/null || true
fi

update-desktop-database "${MENUDIR}" 2>/dev/null || true

# --- prove what is there ------------------------------------------------------
COUNT=0
for f in $MAPFILES; do
    [ -f "${APPDIR}/${f}" ] && COUNT=$((COUNT + 1))
done

echo ""
if [ "$COUNT" -eq 6 ] && [ -x "${APPDIR}/JS8Map" ] \
   && [ -f "${APPDIR}/build_canadian_db.py" ] \
   && grep -q "${APPDIR}/JS8Map" "${MENUDIR}/js8map-spotter.desktop"; then
    echo "DONE. JS8Map Spotter is installed in:"
    echo "    ${APPDIR}"
    echo "The menu entry and desktop icon point there."
else
    echo "WARNING: the install finished but the folder above does not look right."
fi
echo ""
echo "Next:"
echo "  1. In JS8Call: File > Settings > Reporting -- tick Enable TCP Server API and"
echo "     Accept TCP Requests, port 2442, TCP Max Connections 5. Restart JS8Call."
echo "  2. Start it from the applications menu or the desktop icon."
echo "  3. A newer version later: close Spotter and paste the same install lines."
echo ""
INSTALL_EOF
chmod 755 "${STAGE}/install.sh"

# ---------------------------------------------------------------------------
# 6. Write uninstall.sh into the package
# ---------------------------------------------------------------------------
cat > "${STAGE}/uninstall.sh" <<'UNINSTALL_EOF'
#!/bin/bash
# ============================================================================
#  JS8Map Spotter uninstaller for Linux (JS8Map 1.75 is not touched)
#
#  Run:   bash ~/Applications/JS8Map_Spotter_*_linux/uninstall.sh
#
#  Removes this program folder and its launchers, and the old
#  ~/.local/lib/JS8MapSpotter copy if there is one.
#  Your settings and databases are NOT touched.
# ============================================================================

set -e

APPDIR="$(cd "$(dirname "$0")" && pwd)"
OLDLIB="${HOME}/.local/lib/JS8MapSpotter"
MENUDIR="${HOME}/.local/share/applications"
DESKDIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "${HOME}/Desktop")"
DATADIR="${XDG_DATA_HOME:-${HOME}/.local/share}/JS8Map Spotter"

# Only ever delete a Spotter program folder, never a data folder.
if [ ! -f "${APPDIR}/JS8Map" ] || [ "${APPDIR}" = "${DATADIR}" ]; then
    echo "STOP: run this from the JS8Map Spotter program folder."
    exit 1
fi

echo "This will remove:"
echo "    ${APPDIR}"
[ -f "${OLDLIB}/JS8Map" ] && echo "    ${OLDLIB}"
echo "    ${MENUDIR}/js8map-spotter.desktop"
echo "    ${MENUDIR}/js8map-spotter-map.desktop"
echo "    ${DESKDIR}/JS8Map-Spotter.desktop"
echo ""
echo "Your settings and databases are in a separate folder:"
echo "    ${DATADIR}"
echo "That folder will NOT be touched."
echo ""
printf "Type YES to continue: "
read -r ANSWER

# Accept y / yes / YES and anything between. The old test was an exact match on
# "YES", so a lower-case "yes" silently cancelled -- safe, but every new
# operator hits it once.
case "$ANSWER" in
    [Yy]|[Yy][Ee][Ss]) ;;
    *)
        echo "Nothing was removed."
        exit 0
        ;;
esac

rm -f "${MENUDIR}/js8map-spotter.desktop" "${MENUDIR}/js8map-spotter-map.desktop"
rm -f "${DESKDIR}/JS8Map-Spotter.desktop"
update-desktop-database "${MENUDIR}" 2>/dev/null || true
[ -f "${OLDLIB}/JS8Map" ] && rm -rf "${OLDLIB}"
rm -rf "${APPDIR}"

echo ""
echo "DONE. JS8Map Spotter has been removed."
echo ""
UNINSTALL_EOF
chmod 755 "${STAGE}/uninstall.sh"

# ---------------------------------------------------------------------------
# 7. Write the operator's read-me
# ---------------------------------------------------------------------------
cat > "${STAGE}/README-INSTALL.txt" <<'README_EOF'
JS8Map Spotter 1.76 for Linux
=============================

Installs alongside JS8Map 1.75 and does not change it.
No root password is needed. Everything stays inside your own home folder.


TO INSTALL
----------
Save the .tar.gz in your Downloads folder. Open a terminal (Ctrl+Alt+T),
paste these three lines and press Enter:

    F="$(ls -t ~/Downloads/JS8Map_Spotter_*_linux.tar.gz | head -n 1)"
    mkdir -p ~/Applications && tar -xzf "$F" -C ~/Applications
    bash ~/Applications/"$(tar -tzf "$F" | head -n 1 | cut -d/ -f1)"/install.sh

When it finishes, JS8Map Spotter is in your applications menu and has an
icon on your desktop.


TO UPDATE
---------
Close JS8Map Spotter, save the new .tar.gz in Downloads, and paste the same
three lines. Answer y when it offers to remove the older version. Your
settings are kept.


BEFORE YOU START IT
-------------------
In JS8Call, open File > Settings > Reporting. Tick Enable TCP Server API and
Accept TCP Requests, port 2442, and set TCP Max Connections to 5. Restart
JS8Call. Each program talking to JS8Call takes one connection: JS8Map,
JS8FastChat, and anything else such as JS8Spotter or CommStat. At 1 there are
not enough to go round, and a refused connection is silent.


THE MAP WORKS OFFLINE
---------------------
No map key is needed and no internet connection is needed for the map to
draw. Coastlines, borders, state and province lines, lakes, place names
and stations all draw with the network off. Street-level detail is the
only thing that needs a connection, and it is optional.


TO REMOVE IT
------------
    bash ~/Applications/JS8Map_Spotter_*_linux/uninstall.sh

Your settings and logs are left alone.
README_EOF

# ---------------------------------------------------------------------------
# 8. Make the tarball
# ---------------------------------------------------------------------------
rm -f "${PROJECT_DIR}/${PKGNAME}.tar.gz"
cd "${PROJECT_DIR}/pkgbuild"
tar czf "${PROJECT_DIR}/${PKGNAME}.tar.gz" "${PKGNAME}"
cd "${PROJECT_DIR}"
rm -rf "${PROJECT_DIR}/pkgbuild"

# ---------------------------------------------------------------------------
# 9. Prove what is in it. Last thing printed, so it cannot be missed.
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " WHAT IS INSIDE THE PACKAGE"
echo "============================================================"
tar tzf "${PROJECT_DIR}/${PKGNAME}.tar.gz" | sed 's|^|  |'
echo ""
echo "============================================================"
echo " PACKAGE BUILT"
echo "============================================================"
echo ""
ls -lh "${PROJECT_DIR}/${PKGNAME}.tar.gz"
echo ""
sha256sum "${PROJECT_DIR}/${PKGNAME}.tar.gz"
echo ""
echo "Full path:"
echo "  ${PROJECT_DIR}/${PKGNAME}.tar.gz"
echo ""
