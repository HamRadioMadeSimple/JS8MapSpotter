# JS8Map Spotter

**Windows and Linux** · [Download](https://github.com/HamRadioMadeSimple/JS8MapSpotter/releases/latest) · [Guides](docs) · [Video](https://youtu.be/P38tYfbgYMI) · [Website](https://hamradiomadesimple.github.io/)

A live map of every station [JS8Call](https://js8call.com) hears, with the
emergency-communications traffic on top:

- **CommStat StatReps**, alerts and RRSR acks, as diamonds on the map, in a
  StatRep box and in a table
- **MCForms** (JS8Spotter / SitRepNet `F!` micro forms, such as F!104),
  decoded into plain words and shown as numbered squares
- **QSOs between other stations**, as 💬 badges, dashed lines and messages in
  the station popup
- a **tagged traffic log** of every directed message heard, kept for 7 days

Stations are placed from their grid, or from the FCC and Canadian license
databases, which Spotter builds on your own PC. The map draws offline.
Spotter takes everything live from JS8Call's TCP API, so JS8Spotter does not
need to be running.

It never transmits on its own: nothing goes out unless you click a send button,
and the map's buttons carry a private key so another web page can't make your
radio transmit.

Current version: **1.76** (build 2026-10-29f). Windows and Linux.

JS8Map Spotter installs **alongside JS8Map 1.75** and does not change it: own
folder, settings, icon and taskbar button. It works with
**[JS8FastChat](https://github.com/HamRadioMadeSimple/JS8MapChat)** for per-station chat.

---

## Before you install

**In JS8Call:** File > Settings > Reporting. Tick *Enable TCP Server API* and
*Accept TCP Requests*, port **2442**, *TCP Max Connections* **5**. Restart
JS8Call.
Each program that talks to JS8Call (JS8Map Spotter, JS8FastChat, JS8Spotter,
CommStat) takes one connection. At the default of 1, the ones that miss out
fail silently.

**For the map window**, have a Chromium-family browser: Edge (on every Windows
PC), Chrome, Brave or Chromium. Without one the map opens in your normal browser.

Start order: **JS8Call, then JS8Map Spotter, then JS8FastChat** if you use it.

---

## Install on Windows

1. Open the [Releases](https://github.com/HamRadioMadeSimple/JS8MapSpotter/releases/latest)
   page and download `JS8Map_Spotter_v1.76_build_2026-10-29f_Setup.exe`. Your
   browser saves it to your Downloads folder.
2. Double-click it. If Windows says "Windows protected your PC", click
   **More info** > **Run anyway**. Then **Next**, **Install**, **Finish**.
3. Start **JS8Map Spotter** from the desktop icon. The first-run setup downloads
   the FCC database (about 100 MB, 2–5 minutes), offers the Canadian database,
   and asks for your callsign and grid. Then click **Generate Map**.

To update, download the newer `Setup.exe` and run it. Your settings are kept.

**No installer?** Download `JS8Map_Spotter_v1.76_build_2026-10-29f_windows.zip`
instead, right-click it > **Properties** > tick **Unblock** if shown, then
**Extract All…** into Documents and double-click `JS8Map.exe`.

The one-page [Windows Quick Install](docs/JS8Map_Spotter_1.76_Windows_Quick_Install.pdf)
has both ways, the JS8Call settings and troubleshooting.

## Install on Linux

For Linux Mint 21, Ubuntu 22.04, Debian 12 or newer, on a normal 64-bit PC (not a
Raspberry Pi). No Python is needed; the package is ready to run.

1. Open the [Releases](https://github.com/HamRadioMadeSimple/JS8MapSpotter/releases/latest)
   page and download `JS8Map_Spotter_v1.76_build_2026-10-29f_linux.tar.gz`.
   Your browser saves it to your Downloads folder.
2. Open a terminal (Ctrl+Alt+T), paste these two lines, and press Enter:

```sh
tar -C ~/Downloads -xzf ~/Downloads/JS8Map_Spotter_v1.76_build_2026-10-29f_linux.tar.gz
bash ~/Downloads/JS8Map_Spotter_v1.76_linux/install.sh
```

It ends with **DONE**. The program goes into `~/.local/lib/JS8MapSpotter`, with
a menu entry and a desktop icon.

**To update:** close Spotter, download the newer `.tar.gz` into Downloads, and
run the same two lines with the new file name. Your settings are kept.

**To remove:**

```sh
bash ~/Downloads/JS8Map_Spotter_v1.76_linux/uninstall.sh
```

Your settings are left in place.

The one-page [Linux Quick Install](docs/JS8Map_Spotter_1.76_Linux_Quick_Install.pdf)
has the same steps, the JS8Call settings and troubleshooting.

---

## Where your settings live

| | Windows | Linux |
|---|---|---|
| Settings, databases, crash log | `%LOCALAPPDATA%\JS8Map Spotter` | `~/.local/share/JS8Map Spotter` |
| Mailbox shared with JS8FastChat | `%LOCALAPPDATA%\JS8MapChat\Shared` | `~/.local/share/JS8MapChat/Shared` |

Installing, updating or removing the program never touches them. When you
report a problem, please don't send `ham_map_config.json`, the `*.db` files or
`js8map_request_token.txt`: they are your own data.

---

## Documentation

- **[JS8Map Spotter 1.76 User Guide](docs/JS8Map_Spotter_1.76_User_Guide.pdf)** -
  the map, the tables, StatReps, MCForms, QSOs and sending.
- **[Windows Quick Install](docs/JS8Map_Spotter_1.76_Windows_Quick_Install.pdf)** - one page.
- **[Linux Quick Install](docs/JS8Map_Spotter_1.76_Linux_Quick_Install.pdf)** - one page.
- **[CHANGELOG.md](CHANGELOG.md)** - what changed in each release.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - how the program is built, for
  contributors.
- **[Request token (TX protection)](docs/Request_Token_TX_Protection.md)** -
  how the map's send buttons are protected.

## Hot keys (on the map)

| Key | Action |
|---|---|
| `F` | Fit All |
| `R` | Pull fresh data from JS8Call and rebuild |
| `/` | Jump to the Find box |
| `L` / `D` | Labels on and off / dark or light map |
| `1` `2` `3` `4` | All stations / I hear / mutual / via heartbeat |
| `+` / `-` | Zoom in / out |
| `Esc` | Close the popup, the table and the Map Filters menu; clear Find |

## For contributors

Run from source: `debug.bat` (Windows) or `sh debug.sh` (Linux). Python 3.8 or
newer with Tk; standard library only.

Tests: `python -m unittest discover -s tests` (26 tests) and
`bash tests/test_linux_scripts.sh` (28 checks of the Linux scripts).

Release packages are made only by the scripts, never by hand:
`tools/make_release.py` (source zip), `build_linux.sh` (Linux package) and
`build_windows.bat` (Windows installer and portable zip). They leave out
operator data and refuse to finish if any gets in. See ARCHITECTURE.md
section 7. Publishing a release on GitHub runs the same scripts
(`.github/workflows/release.yml`) and attaches their files to the release.

`shared_resolver.py` must stay byte-identical with JS8FastChat's copy
(`js8fastchat/shared_resolver.py` in JS8MapChat), or the two programs stop
finding each other, with no error. Change both or neither.

## Credits

See [NOTICE.md](NOTICE.md).

## License

Copyright (C) 2026 MJ Jordan (KW3KW)

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. The full text is in [LICENSE](LICENSE).

JS8Map Spotter is an independent companion to JS8Call and is not affiliated
with or endorsed by the JS8Call project.

## Reporting problems

Open an issue on the [Issues](https://github.com/HamRadioMadeSimple/JS8MapSpotter/issues)
tab. Please include the build from the bottom of the StatRep box (for example
`build 2026-10-29f`), Windows or Linux, your JS8Call version, and a screenshot.

73 de KW3KW - Ham Made Simple
