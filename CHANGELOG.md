# Changelog

What changed in each JS8Map Spotter release, for the people who use it.
(The developer's build-by-build log is `CHANGELOG_JS8MAPCHAT.txt`.)

## 1.76 — build 2026-10-29f

First release on GitHub.

- **Ready-to-run downloads, no Python needed:**
  - Windows 10 / 11: `JS8Map_Spotter_v1.76_build_2026-10-29f_Setup.exe`
    (installer) or `JS8Map_Spotter_v1.76_build_2026-10-29f_windows.zip`
    (portable: unzip, double-click `JS8Map.exe`).
  - Linux: `JS8Map_Spotter_v1.76_build_2026-10-29f_linux.tar.gz`, for Linux
    Mint 21, Ubuntu 22.04, Debian 12 or newer on a 64-bit PC. Installs with two
    terminal lines (see the Linux Quick Install).
- **Settings live in a per-user folder** (`%LOCALAPPDATA%\JS8Map Spotter` on
  Windows, `~/.local/share/JS8Map Spotter` on Linux), so updates keep them. If
  you ran an earlier zip version, the setup wizard runs once more.
- **Small-screen fix:** Popup, New and Active moved into **Map Filters ▾ →
  Station display**, so the filter bar fits on one line; the Find box widens
  when clicked.
- **New guides:** Windows Quick Install, Linux Quick Install and an updated
  User Guide (PDF, attached below and in the `docs` folder).
- **JS8Call setting:** TCP Max Connections **5** (each program that talks to
  JS8Call takes one).

When you report a problem on the
[Issues](https://github.com/HamRadioMadeSimple/JS8MapSpotter/issues) page, give
the build shown at the bottom of the StatReps box on the map.
