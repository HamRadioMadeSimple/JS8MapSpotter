#!/bin/sh
# install_linux_launcher.sh -- add JS8Map Spotter to the Linux menu with the
# current logo, and give its map window the same sharp icon.
#
#   sh tools/install_linux_launcher.sh            (run from the app folder)
#   sh tools/install_linux_launcher.sh --remove   (take both entries out)
#
# Writes two files to ~/.local/share/applications/ and a desktop icon:
#   js8map-spotter.desktop      menu entry; matches the main window
#                               (StartupWMClass=Js8mapspotter)
#   js8map-spotter-map.desktop  hidden; matches the map window
#                               (StartupWMClass=127.0.0.1__ham_map.html) so the
#                               taskbar shows the logo instead of the browser's
#                               small, blurry page icon.
# Does not touch an existing JS8Map 1.75 launcher (js8map.desktop).
set -e
APP="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
MAIN="$DEST/js8map-spotter.desktop"
MAP="$DEST/js8map-spotter-map.desktop"

# Desktop folder (localized names, e.g. "Bureau", come from xdg-user-dir)
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
DESKICON="$DESK/JS8Map-Spotter.desktop"

if [ "$1" = "--remove" ]; then
    rm -f "$MAIN" "$MAP" "$DESKICON"
    echo "Removed $MAIN, $MAP and $DESKICON"
    exit 0
fi

ICON="$APP/JS8Map_icon.png"
if [ -x "$APP/dist/JS8Map" ]; then
    EXEC="\"$APP/dist/JS8Map\""         # frozen build present: use it
else
    EXEC="sh \"$APP/debug.sh\""          # run from source
fi

mkdir -p "$DEST"
cat > "$MAIN" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=JS8Map Spotter
GenericName=JS8Call Map
Comment=StatReps, MCForms and QSOs heard on JS8Call, on a map
Exec=$EXEC
Path=$APP
Icon=$ICON
Terminal=false
Categories=Network;HamRadio;
StartupNotify=true
StartupWMClass=Js8mapspotter
DESKTOP

cat > "$MAP" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=JS8Map Spotter Map
Exec=$EXEC
Icon=$ICON
NoDisplay=true
StartupWMClass=127.0.0.1__ham_map.html
DESKTOP

chmod +x "$MAIN" "$MAP"

# Desktop icon: a copy of the menu entry. Marked trusted so Cinnamon /
# GNOME / MATE start it on double-click without an "untrusted" prompt.
if [ -d "$DESK" ]; then
    cp "$MAIN" "$DESKICON"
    chmod +x "$DESKICON"
    gio set "$DESKICON" metadata::trusted true 2>/dev/null || true
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DEST" >/dev/null 2>&1 || true
echo "Installed:"
echo "  $MAIN"
echo "  $MAP"
[ -f "$DESKICON" ] && echo "  $DESKICON  (desktop icon)"
echo "JS8Map Spotter is now in the menu (Ham Radio / Internet)."
echo "If the taskbar still shows an old icon, log out and back in once."
