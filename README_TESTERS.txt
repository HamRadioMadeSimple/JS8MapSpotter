JS8Map Spotter 1.76 -- tester notes
===================================

JS8Map Spotter puts the stations JS8Call hears on a map, and adds emergency-
communications traffic heard on the air: CommStat StatReps and alerts
(diamonds), MCForms check-ins such as F!104 (squares), and QSOs between other
stations (chat badges and dashed lines). Tables list every report and every
directed message for the last 7 days, with sorting and filters.

It is a test build. Thank you for trying it.

It installs ALONGSIDE JS8Map 1.75 and does not change it: separate folder,
separate settings and databases, separate icon.

It never transmits on its own. Nothing goes out unless you click a send button.


BEFORE YOU START: JS8Call
-------------------------
In JS8Call, open File > Settings > Reporting:
  - tick "Enable TCP Server API" and "Accept TCP Requests"
  - the port is 2442 (leave it)
  - set "TCP Max Connections" to 5 (JS8Call ships with 1; each program that
    talks to JS8Call -- Spotter, JS8FastChat, JS8Spotter, CommStat -- takes
    one, and a program that misses out fails silently)
Restart JS8Call after changing these.

A Chromium-family browser is used for the map window: Edge (already on every
Windows PC), Chrome, Brave or Chromium. Without one the map opens in your
normal browser instead.


WINDOWS
-------
1. Install Python 3.8 or newer from https://www.python.org/downloads/
   During setup tick "Add python.exe to PATH". Keep the default options
   (they include Tk, which the program window needs).
2. Unzip this file anywhere you like, e.g. Documents. It makes a folder
   called "Spotter Mapper Ver 1.76".
3. Open that folder and double-click  debug.bat
   A black console window opens behind the program; leave it open -- any
   error message appears there.


LINUX (Mint / Ubuntu / Debian)
------------------------------
1. Unzip into your home folder (save the zip in Downloads first):
       unzip ~/Downloads/JS8Map_Spotter_Ver_*_build_*.zip -d ~/JS8MapSpotter
2. Run the setup script, once:
       sh ~/JS8MapSpotter/Spotter*/linux_install.sh
   It checks for Python with Tk (and unzip and wmctrl), shows the apt command
   for anything missing and offers to run it, then adds the menu entry and a
   desktop icon. Run it again after installing anything it asked for.
3. Start it from the desktop icon, or with  ./debug.sh  in the folder.


FIRST RUN
---------
A setup wizard asks for your callsign and grid and offers to download the
FCC (and optional Canadian) callsign databases, used to place stations that
don't send a grid. The US download takes several minutes.

Then press Generate Map. The map opens in its own window.


UPDATING TO A NEWER TEST BUILD
------------------------------
Close the program and its map window first.

Linux: save the new zip in Downloads, then run
       sh ~/JS8MapSpotter/Spotter*/update_linux.sh
   It picks the newest zip in Downloads, renames the folder if the version
   changed, unzips over it and re-points the desktop icon.
Windows: unzip the new file into the SAME place, replacing files.

Either way your settings and databases are kept: they are not in the zip.
The build tag is at the bottom of the StatReps box on the map
(e.g. "build 2026-10-29a") -- check it changed.


WHAT TO SEND BACK
-----------------
  - the build tag from the bottom of the StatReps box
  - Windows or Linux, and which JS8Call version
  - a screenshot of anything that looks wrong, and what you clicked first
  - if the program stopped: crash.log from
        Windows:  %LOCALAPPDATA%\JS8Map Spotter\crash.log
        Linux:    ~/.local/share/JS8Map Spotter/crash.log
    and anything shown in the console window.

Please do NOT send your ham_map_config.json, the *.db files or
js8map_request_token.txt from the program folder -- they are your own data.


OPTIONAL: TEST WITHOUT A RADIO
------------------------------
tools/fake_js8call.py stands in for JS8Call and plays a few sample stations,
a StatRep, an F!104 form and a short QSO. Close JS8Call first (same port),
then run  python tools/fake_js8call.py  in one window and the program in
another. Nothing is transmitted. The sample callsigns are real stations, so
the map places them at their real addresses; delete js8_spots.db* and
js8map_statrep.db* in the program folder afterwards to clear them.


73 de KW3KW
