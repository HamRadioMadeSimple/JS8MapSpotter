# JS8Map Spotter: Architecture (Ver 1.76, build 2026-10-29f)

> This describes JS8Map Spotter **as actually built** at build 2026-10-29f
> (program code as 29b; 29c–29f changed the release and build scripts). Spotter is a fork of **JS8Map 1.75** (JS8MapChat 1.75.1, in
> [github.com/HamRadioMadeSimple/JS8MapChat](https://github.com/HamRadioMadeSimple/JS8MapChat)),
> so the JS8MapChat architecture notes cover everything inherited unchanged. This document covers what Spotter adds, what it changes, and the
> rules that now differ from JS8Map.
>
> The source code is authoritative. If this document and the code disagree,
> the code wins; update this document from the code tree.
>
> Last synced: 2026-10-29, session "JS8Map Spotter Linux Testing"
> (builds 17e–29a). Replaces "architecture Ver 1.1" and "Ver 1.2".
> **Revised 2026-11-12 for the GitHub repository
> [github.com/HamRadioMadeSimple/JS8MapSpotter](https://github.com/HamRadioMadeSimple/JS8MapSpotter)**
> (GPL-3.0): §2, §3.7, §7 and §9 updated; the rest is as of 29a.
> **Revised 2026-11-20 for build 29f:** `build_windows.bat` added; the
> 2026-11-02 `~/Applications` Linux layout dropped (§3.7); releases are built by
> GitHub Actions (§7).
>
> **Version numbering:** Spotter was 1.1 → 1.2 → **1.76** (20a, operator
> 2026-10-20): it is the upgrade of JS8Map 1.75.1. Builds 17e–19c were "1.2";
> the program code of 20a and 29a equals 19c (29a adds Linux scripts only). Not to be confused with the JS8MapChat document
> `JS8MAPCHAT_ARCHITECTURE_Version_1_76.md`.

---

## 1. What JS8Map Spotter is

JS8Map Spotter is a desktop app for amateur-radio operators running JS8Call.
It connects to JS8Call's TCP API and plots heard stations on a local
HTML/Leaflet map, as JS8Map does. On top of that, it adds **emergency-
communications traffic**:

- **CommStat StatReps, alerts and RRSR acks.** These appear as diamonds on the
  map, in a StatRep box and in a table.
- **MCForms** (JS8Spotter / SitRepNet "micro forms", `F!104 …`). These are
  decoded against the form files and shown as squares on the map.
- **QSOs between other stations,** heard as band activity. These appear as 💬
  badges, a dashed teal line between the two stations, and the message text in
  station popups.
- **A tagged traffic log** of every directed message heard, kept for 7 days.

Spotter takes everything **live from the JS8Call TCP API**, so **JS8Spotter does
not need to be running**. Reading JS8Spotter's database is an optional import
for traffic heard while Spotter was closed.

**Since 1.2 (now 1.76), Spotter is a separate product from JS8Map 1.75** (operator
decision 2026-10-17): its own installer ID, install folder, per-user data
folder, menu entries, icons and taskbar identity. Both can be installed on the
same PC. They still share the FastChat mailbox and the FCC database folder.

```
   JS8Call (TCP API :2442)
        │  RX.SPOT / RX.DIRECTED / RX.ACTIVITY / STATION.* …
        ▼
   ┌──────────────────────────────────────────────┐
   │ JS8Map Spotter  (JS8Map.py + js8map_*.py)    │
   │   JS8CallClient ──► SpotDatabase   js8_spots.db       (stations, 7 days)
   │        │                                              │
   │        └────────► StatRepSink ──► StatRepStore js8map_statrep.db
   │                                   (StatReps, alerts, acks, lost,
   │   JS8SpotterImporter (optional) ──┘  MCForms, traffic)
   │                                              │
   │   local HTTP server 127.0.0.1:<random> ──────┤ /data.json /statrep.json …
   └──────────────────────────────────────────────┘
        ▲  GET (data)   POST (send / relay; needs request token)
        │
   map window: Chromium --app (Brave / Chrome / Edge / Chromium),
               ham_map.html + boot.js + app.js + app.css + leaflet
```

JS8FastChat is still a separate app. It coordinates with Spotter through the
**shared mailbox** of JSON files ("JS8MapChat Shared"). One contract change in
1.2/1.76: `js8map_server.json` now carries `data_dir` (§5.1), so FastChat's
`db_locator.py` reads Spotter's live database instead of guessing.

---

## 2. Status at a glance

| Item | State |
|---|---|
| Version | `APP_NAME = "JS8Map Spotter"`, `APP_VERSION = "1.76"` (js8map_runtime.py) |
| Build | `2026-10-29f`: `STATREP_BUILD` (js8map_statrep.py) and `SR_PAGE_BUILD` (app.js) must match |
| Windows | **Installer built and in daily use by the operator** (reported 2026-11-12). Since 29f, `build_windows.bat` (work in `tools/build_windows.py`) makes `JS8Map_Spotter_v1.76_build_<tag>_Setup.exe` and a portable `…_windows.zip` in one go; `Build_JS8Map.bat` is the older two-step build. Also runs from source (`debug.bat`). |
| Linux | **Linux Mint, from source, real JS8Call, tested by the operator through 19c** (from the desktop icon), including the relay legs on the air. Steps to update to 20a were given 2026-10-25 (result not reported). **29a adds `linux_install.sh` and `update_linux.sh`** (§3.7), tested in throwaway home folders, not yet on the operator's PC. The app was also run end-to-end in the cloud test box (Xvfb + openbox + Chromium, fake radio). |
| Tests | `python -m unittest discover -s tests`: **26 tests**, standard library only; pass on Python 3.12, 3.13 and 3.14. Plus `bash tests/test_linux_scripts.sh`: **28 checks** of the Linux scripts (29d). Both re-run and passing 2026-11-12 in the repository layout. |
| Python | 3.8 or newer. Standard library only, apart from PyInstaller for builds. |
| Code size | About 13,200 lines of Python, plus `app.js` (4,794 lines) and `app.css` (1,160 lines). |
| Testers | **29a** is the build to send: one zip for both systems, `README_TESTERS.txt` inside, and `JS8Map_Spotter_1.76_Linux_Install_Guide.docx` (Word, sent separately; uses the two scripts). |

**Roadmap (operator's order):**
1. Build and test: **about 95% done** (operator, 2026-10-20).
2. Linux testing: done for the operator's PC; **outside testers next.**
3. FastChat and relay.
4. GitHub: **done 2026-11-12** — own repository, README, LICENSE (GPL-3.0),
   NOTICE.md (credits), personal paths removed.

---

## 3. Module map

Spotter keeps JS8Map 1.75's structure: an entry file, mixins, engines,
domain/data, and foundation. Modules **new in Spotter** are marked ★, and
modules **changed in Spotter** are marked ✎.

### 3.1 Entry and HamMapApp mixins

| Module | Owns | Spotter notes |
|---|---|---|
| `JS8Map.py` ✎ | crash hooks, `HamMapApp` shell, `main()` | Wires the StatRep store, sink, importer and form catalog, plus the `/statrep.json` and `/qso*.json` providers. Window class `JS8MapSpotter` (WM_CLASS `Js8mapspotter`); Windows AppUserModelID **`KW3KW.JS8MapSpotter`** (version-less since 1.2, so a pinned button survives updates). `crash.log` goes to the per-user **`JS8Map Spotter`** folder on every OS. |
| `js8map_app_ui.py` | TX-mode control, app dialogs | unchanged |
| `js8map_mapgen.py` | map build/refresh pipeline | unchanged |
| `js8map_relay_conn.py` | JS8Call connection, relay arm/clear | unchanged (relay phase pending) |
| `js8map_buildui.py` ✎ | Tk widget tree | Adds the **📋 StatReps…** window: JS8Spotter path, import on/off, UTC/local, Import now, Clear, Open forms folder, Reload forms. |

### 3.2 Engines and services

| Module | Owns | Spotter notes |
|---|---|---|
| `js8map_client.py` ✎ | `JS8CallClient`, the TCP API client | Hands every RX.DIRECTED (with JS8Call's `CMD`) and RX.ACTIVITY frame to `StatRepSink`. |
| ★ `js8map_statrep.py` | Parsing (CommStat, lost frames), `StatRepStore`, `StatRepSink` (live feed and band-activity frame joining), `JS8SpotterImporter`, `build_payload` | See §4. **Leaf module**: imports only `js8map_util` and `js8map_forms`; the grid resolver is injected. |
| ★ `js8map_forms.py` | `FormCatalog` (MCF*.txt), form message parser, decoder, datecode, `tag_message()`, garble/QSO tests | CLI: `python js8map_forms.py "message"`. |
| `js8map_web.py` ✎ | local HTTP server, render, `wire()` | Request token, threaded server, the Spotter endpoints (§5), and **`server_info()`** (body of `js8map_server.json`, with `data_dir`). **Importing this module creates the request token** in the data folder (`_REQ_TOKEN` at import time) — see §7 "Release zips". |
| `js8map_tx.py` | **the transmit gate** | unchanged: still the only code allowed to transmit |
| `js8map_relay.py` | relay shared state | unchanged |
| `js8map_fastchat.py` | cross-app mailbox and TX lease | "from KW3KW" fallback made blank 2026-11-12 |
| `js8map_wizard.py` | first-run wizard | unchanged: FCC database → Canadian database → your station |

### 3.3 Domain / data

`js8map_activity_store.py`, `js8map_relay_db.py`, `js8map_fcc.py`,
`js8map_group_config.py`, `js8map_js8call_ini.py`, `zip3_latlon.py` and
`build_canadian_db.py` are **unchanged** from JS8Map 1.75.

Group membership for the map's group filter comes from
`activity_store.get_group_colors()`: `{call: {color, group, all_groups:
{name: color}}}`, built from stations heard on the groups in JS8Call's
config, within the station window. The page sees it as `station.group_all`.

### 3.4 Foundation

| Module | Spotter notes |
|---|---|
| `js8map_runtime.py` ✎ | `APP_NAME`/`APP_VERSION`; **`DATA_FOLDER_NAME = "JS8Map Spotter"`** (frozen builds' per-user folder; was JS8Map 1.75's "JS8Map" until 17e); config keys `js8spotter_db_path`, `js8spotter_import`, `js8spotter_time`, `require_request_token`; `load_or_create_request_token()` |
| `js8map_theme.py` ✎ | the **Ocean Teal** palette |
| `js8map_platform/` ✎ | ★ **`common.py`**: `is_spotter_map_title()` — the map window must be titled exactly `JS8Map Spotter` or `<CALL> · JS8Map Spotter`. **`windows.py`** also requires the window's process to be brave/chrome/msedge/chromium.exe. **`linux.py`** requires the `ham_map.html` WM_CLASS **and** the exact title (wmctrl, then xdotool). See §6 "Generate Map". |
| `shared_resolver.py` | **unchanged and still the TWIN** of FastChat's copy (byte-identical; see §7) |
| `js8map_util.py`, `js8map_dialogs.py`, `js8map_tooltip.py` | unchanged |
| `js8map_alive_poller.py` | **unused**. Decide in the FastChat phase. |

### 3.5 Map page (browser side)

| File | Role |
|---|---|
| `index.html` ✎ | The page shell. Header text hard-coded ("JS8Map&nbsp;Spotter&nbsp;Ver&nbsp;1.76"). Holds the header **Return to Map** button. **Copied to `ham_map.html` only when the map is rebuilt** — see §7 "Page shell vs. script". |
| `boot.js` | **Generated on every render**, never shipped. Holds the operator's call, grid, stations and `req_token`. |
| `app.js` ✎ | All page logic: boot hydrate → token fetch wrapper → map and stations (`LAYERS`, `LAYER_MAP`) → polls → relay chain → StatRep layer, box and table → MCForms → QSO layer → Table view → group filter for tables/markers. |
| `app.css` ✎ | Layout "A" toolbar, StatRep box, table view, Return to Map, group chip, Ocean Teal |
| `leaflet.js/.css`, `js8map_*.json` | Offline map. Unchanged. |

**Polls (the page pulls; the server never pushes):**

| Poll | Every | Endpoint | Notes |
|---|---|---|---|
| `_pollData` | 5 s | `/data.json` | stations; cheap timestamp check |
| `_pollRelayAnim` | 1 s | `/relay_anim.json` | relay comet states and the relay outcome bar |
| `_srPoll` | 15 s | `/statrep.json?hours=&rev=` | `{"unchanged":true}` (~0.3 KB) when nothing changed; full refresh at least once a minute |
| `_qsoPoll` | 20 s | `/qso_active.json?minutes=` | 💬 badges and QSO lines |
| FastChat alive | 3 s | `/fastchat_alive` | FastChat button state |

### 3.6 Dependency direction (still downward, no cycles)

```
JS8Map.py
  └─> mixins (app_ui, mapgen, relay_conn, buildui)
        └─> engines (client, statrep★, forms★, web, tx, relay, fastchat, wizard)
              └─> domain (activity_store, relay_db, fcc, group_config, js8call_ini)
                    └─> foundation (theme, util, runtime, platform, dialogs, tooltip, shared_resolver)

  statrep★ -> {util, forms★}           (grid resolver injected by JS8Map.py)
  forms★   -> {runtime}
  client   -> {activity_store, relay, util}   + StatRepSink injected
  web      -> {util, theme, runtime, relay, platform, client}
  platform.windows / platform.linux -> platform.common
```

### 3.7 Linux scripts (top of the app folder, 29a)

| Script | Run as | Does |
|---|---|---|
| `linux_install.sh` | `sh ~/JS8MapSpotter/Spotter*/linux_install.sh` | First-time setup. Checks Python 3.8+ with Tk (needed), `unzip` and `wmctrl` (recommended); shows the `sudo apt install …` line and offers to run it (asks; no answer = no); checks for a Chromium-family browser (same list as `js8map_platform/linux.py`); restores executable marks; runs `tools/install_linux_launcher.sh`; prints the JS8Call settings and the update command. Stops, writing nothing, if Tk is missing. Honors `PYTHON=`. |
| `update_linux.sh` | `sh ~/JS8MapSpotter/Spotter*/update_linux.sh [zip]` | Picks the zip named, or the **newest** `JS8Map_Spotter_Ver_*_build_*.zip` in `~/Downloads` (`xdg-user-dir DOWNLOAD`), never a `_Windows` zip; reads the folder name and build tag **inside** the zip; refuses a zip with operator data (token, config, `.db`) or that is not a Spotter zip; stops if `JS8Map.py` is running **from this folder** (`/proc/<pid>/cwd`); asks before going back to an older build; on a version change renames the folder to the zip's folder name (stops if both names exist); `unzip -o` over it; restores executable marks; re-runs the launcher script; prints old → new build. |
| `tools/install_linux_launcher.sh` | (called by both) | Menu entry, hidden map-window entry, trusted desktop icon, pointing at **this** folder's `debug.sh` (or `dist/JS8Map` if a frozen build is present). `--remove` takes them out. |

Rules: **POSIX `sh`** (Mint's `sh` is `dash`) — no bash-isms; always started
with `sh …` so a zip that lost its executable marks on Windows still works;
the `Spotter*` glob keeps the command the same across version renames;
`shellcheck -s sh` clean. `update_linux.sh` lives **inside** the folder it
updates, so a PC on 20a or older (no script yet) does its first update to 29a
the old way (`unzip -o …`); from then on, the script.

**These scripts are for running from source.** Since 29e the release for Linux
users is a **ready-to-run package** that needs no Python:

| Script | Run as | Does |
|---|---|---|
| `build_linux.sh` (29e) | `sh build_linux.sh` | Checks version and both build tags; downloads PyInstaller once into `.buildenv/`; builds `dist/JS8Map`; runs `make_js8map_package.sh`; writes `output/JS8Map_Spotter_v<v>_build_<tag>_linux.tar.gz` and copies it to `~/Downloads`. Never asks a question. |
| `make_js8map_package.sh` | (called by it) | Stages the program and writes `install.sh`, `uninstall.sh` and `README-INSTALL.txt` into the package. |

Data is always kept in `~/.local/share/JS8Map Spotter`. The package is
unpacked in Downloads and its `install.sh` copies the program to
`~/.local/lib/JS8MapSpotter`: two lines, as in `README.md` and the Linux Quick
Install. (A three-line `~/Applications` layout was tried in this repository on
2026-11-02 but never released; it was dropped at 29f, operator decision
2026-11-20, because the app's own project never carried it.)

**glibc floor.** PyInstaller does not bundle the C library, so the package
starts only on Linux as new as the PC that built it (built on Mint 22: glibc
2.38+, which leaves out Ubuntu 22.04, Debian 12, Mint 21 and 20). **The GitHub
release build runs on Ubuntu 22.04 (glibc 2.35): Mint 21, Ubuntu 22.04, Debian
12 and newer.** Building inside `linux_buildbox/` (Ubuntu 20.04, podman) brings
the floor down to 2.30; see `linux_buildbox/BUILD_BOX_NOTES.txt`. Say which in
each release's notes.

---

## 4. The Spotter data layer (`js8map_statrep.py`, `js8map_forms.py`)

Unchanged since 1.1.

### 4.1 Two feeds, one parser, one store

- **Live.** `JS8CallClient` → `StatRepSink.feed_directed(text, from, to, freq, snr, cmd)`
  and `StatRepSink.feed_activity(text, offset, freq, snr, from)`.
- **History (optional).** `JS8SpotterImporter` reads `js8spotter.db`
  **read-only** (`?mode=ro`) every 30 s, finds columns by name, and keeps a
  per-path watermark. Bumping `PARSER_REV` resets the watermark.
- Both feeds use `parse_message()` → `StatRepStore.add()`. The same report heard
  by both is stored **once**, and its `sources` field lists both.

### 4.2 What the parser recognizes

| Kind | On-air shape |
|---|---|
| StatRep | `CALL: @GRP ,GRID,SCOPE,SRID,STATUS12,REMARKS,{&%}`. `{&%3}` internet copy, `{F%}` forwarded, `+` all green. A blank grid keeps its position. |
| Partial StatRep | Lost frames (`……`) after an intact 12-digit status. Stored with `partial=1`; a later full copy replaces it. |
| Alert | `CALL: @GRP ,ID,COLOR,TITLE,MESSAGE,{%%}` (older form without ID accepted) |
| RRSR ack | `CALL: @GRP RRSR TARGET,SRID` |
| Lost | A group message with lost frames, matched with acks into "heard but incomplete". |
| MCForm | `F!<id> <answers><XX[field]…> <comment> #MDHm`. `E? F!305` is a *request* (MCF_REQ). |

**MCForms datecode** (`#MDHm`): month A–L; day A–Z then 0–4; hour A–X; minute
A–Z then 0–3, in 2-minute steps. It records when the form was **filled in**.
JS8Spotter re-sends stored forms unchanged, so popups say "Form dated … · N
days before heard" (seen on the air 2026-10-19: KF7MIX F!104 dated 3 days
before heard).

### 4.3 `js8map_statrep.db` (Spotter's own file)

Deliberately **not** `js8_spots.db`, which is cleared on QSY and Clear Map and
is FastChat's read contract.

| Table | Holds | Dedup | Kept |
|---|---|---|---|
| `statrep` | StatReps (`partial` column) | call + SRID + status within 12 h | 30 days |
| `statrep_ack` | RRSR acks | UNIQUE(target, SRID, acker) | 30 days |
| `statrep_alert` | alerts | call + title + message within 12 h | 30 days |
| `statrep_lost` | lost-frame group messages | same call within 90 s | 30 days |
| `mcform` | forms, **raw** (decoded when served) | call + form + datecode within 12 h; longer copy replaces shorter | 30 days |
| `traffic` | every directed message, **one tag** from `tag_message()` | same sender, identical or *extended* text within 10 min (acks: 90 s) | **7 days** |
| `meta` | importer watermarks, `parser_rev` | | |

One short-lived connection per call (WAL mode). **`rev_tag`** changes on every
write and powers the "unchanged" poll reply.

### 4.4 Traffic tags (`tag_message`)

Order: CommStat/MCForms markers, then JS8Call's `CMD`, then text rules, then
ack-only, garble, QSO, and finally TEXT.

- **CommStat:** CS_STATREP, CS_ALERT, CS_ACK, CS_OTHER
- **MCForms:** MCF, MCF_REQ, EXPECT
- **JS8Call:** HEARTBEAT, HB_REPLY, CQ, SNR, GRID, INFO, STATUS, HEARING, MSG, APRS, RELAY, ACK, QUERY
- **QSO**, **GARBLE**, **LOST**, **TEXT**

Each tag belongs to one **family** (commstat, mcforms, qso, query, js8, text) —
the Traffic tab's type boxes.

### 4.5 Band activity → QSOs between other stations

JS8Call sends RX.DIRECTED only for traffic to *me or my groups*; everything
else arrives as RX.ACTIVITY frames. `feed_activity` buckets frames per ~10 Hz of
offset, joins them **exactly as sent**, ends a message on the trailing
non-ASCII end-of-message mark (usually `'Ã\x83'`), flushes on a new `CALL:`
frame, and never glues late frames onto a logged message. **Confirmed on the
air 2026-10-17/18** (Windows and Linux): QSOs between other stations appear in
the Traffic table and as 💬 badges. A badge needs the station's dot; the dashed
line needs both dots. A message to a **group** (e.g. WD5EED → @WEATHER) gets a
badge but no line.

---

## 5. The local web server (`js8map_web.py`)

- **Bound to `127.0.0.1` on a random port**, published in the shared mailbox
  as `js8map_server.json` (§5.1).
- **`ThreadingHTTPServer`**: GETs in parallel; **POSTs one at a time** under
  `_POST_LOCK`.
- **Request token** (full design in "JS8Map Spotter – request token (TX
  protection)"): secret `js8map_request_token.txt` in the data folder; sent by
  the page as `X-JS8Map-Token`; checked with `hmac.compare_digest`; 403
  otherwise. `/raise_window` exempt. Off switch:
  `"require_request_token": false`.

### 5.1 `js8map_server.json` (FastChat contract)

Written atomically to the shared mailbox on every launch. **Spotter is the only
writer; FastChat only reads.** Built by `server_info()`:

```json
{"port": 47353, "timestamp": "2026-10-19T11:14:40Z",
 "data_dir": "/home/you/.local/share/JS8Map Spotter"}
```

- `port`: random each launch; FastChat must read it fresh on every click.
- **`data_dir`** (19a): absolute folder holding the **live** `js8_spots.db`.
  Source run → the app folder; frozen build → `%LOCALAPPDATA%\JS8Map Spotter`
  or `~/.local/share/JS8Map Spotter`. FastChat's new `db_locator.py` looks there
  first, then picks the newest copy among the usual places (it had been
  reading a day-old database). Older FastChat builds ignore the key.
  **Tested on Windows 2026-10-19** with the new `db_locator.py`; Linux still due.

**Spotter endpoints:**

| Endpoint | Method | Returns |
|---|---|---|
| `/statrep.json?hours=&rev=` | GET | reports, rows, unplotted, incomplete, alerts, forms (decoded), traffic, tag_counts, forms_catalog, spotter state, counts, `rev`, `build`; or `{"unchanged":true}` |
| `/mcforms.json` | GET | full form definitions (Reference tab) |
| `/qso.json?call=&hours=` | GET | QSO messages for one station's popup |
| `/qso_active.json?minutes=` | GET | stations and pairs in recent QSOs |
| `/fcc_locate.json?call=` | GET | FCC address position (table → map) |
| `/statrep_import` | POST | run the JS8Spotter import now |

The JS8Map endpoints are unchanged apart from the token.

---

## 6. Map page behavior (what the operator sees)

- **Toolbar layout "A".**
  - **Header:** stat tiles, **FC-8** (FastChat) button, then — **only while a
    table is open** — a bold red **🗺 Return to Map** button (18d; replaced the
    small Map button at the far right of each table bar). Then Map Filters ▾,
    Fit All, Box.
  - **Filter bar:** 📋 COMMSTAT · 📝 MCFORMS · 💬 QSOs, each with **✓ Show ·
    Only · 📊 Table**; Popup, New, Active and **Groups** dropdowns; Find
    callsign.
  - **Only views** hide regular stations and edge the map amber (CommStat),
    blue (MCForms) or teal (QSOs). QSO Only hides the lines to my station on
    purpose; it shows only the lines between QSO partners.
- **Groups filter** (`#group-filter`, from JS8Call's groups). With a group
  selected:
  - **Station dots:** members only (`station.group_all`).
  - **Tables (18e) and StatRep diamonds, MCForms squares and their lines
    (19b):** a row/marker stays when it was sent **to** the group or its
    sender (or receiver) is a member — same rule as the dots, so a diamond or
    square never sits on the map without its station. `_grpRowFilter()`,
    `_srReportsShown()`, `_mfLatest()`.
  - A purple **👥 @GROUP ✕** chip in the table bar shows the filter is on;
    clicking it clears it everywhere at once (18f).
- **StatRep diamonds and MCForms squares:** one line each to my station,
  colored by worst status or form series, solid when the grid came in the
  report and dashed when approximate. In the normal view the line is fainter
  and skipped when the station's own dot is within 10 km.
- **Fit All** (button or F key) covers my station, the visible dots and the
  visible diamonds and squares, within the North America fit zone.
- **Time windows:** the main window's **Show** dropdown (stations) and the
  page's **Last 1 h … 2 days** selector (reports/forms/QSOs) are independent.
- **Popups:** capped to the map height and draggable. **Never call
  `popup.update()`** (it wipes the async QSO list).
- **StatRep box** (bottom right): latest report per station, heard but
  incomplete, MCForms list, window selector and the **build footer**.
- **Table view:**
  - Tabs: StatReps · MCForms (click a row to decode) · Traffic · Reference.
    The tab labels carry the totals; the "N messages" counts were removed
    (18d). Reference keeps "N forms loaded".
  - **Click any header to sort** (17h): text columns A→Z first, time/Freq/SNR
    highest first, blanks always last, ties newest first; ▾/▴ on the sorted
    header. Kept through refreshes and filters; reset by a page reload.
    `_tblSort`, `_tblTh`, `_tblSortBy`, `_tblSortRows` (StatReps has its own
    older `_srTblSort`).
  - **Traffic type boxes are single-choice** (18b): All · CommStat · MCForms ·
    QSO · Queries · JS8Call · Text. Ticking one unticks the others; unticking
    the only one goes back to All; picking a type resets the tag dropdown.
    **Arriving at Traffic from another tab, or opening the table onto it,
    starts at All** (18c, `_trEnterTab`); the 💬 QSOs **Table** button is the
    exception and opens on QSO only (`_tblQsoMode`).
  - Esc closes the table.
- **Relay chain:** legs drawn only once the via station's dot exists
  (`_chainLegsWaitVia`, 17d) — **confirmed on the air on Linux 2026-10-18**.
  `_chainLegs[0]` must always be leg 1 (me → via).
- **Relay outcome bar** (bottom right): wraps long messages so **Switch Path**
  and **×** stay on screen (18a); a closed outcome is remembered
  (`_dismissedOutcome`) so the 1 s poll can't bring it back; Switch Path keeps
  the outcome data before closing the bar, so its panel now opens.
- **Generate Map with the map already open** brings Spotter's own map window
  forward instead of opening another. Matching is exact (§3.4): a contains-test
  once raised the **Claude desktop app** (an Electron window whose title held
  a chat named "JS8Map Spotter Linux Testing") and could have raised JS8Map
  1.75's map window.

---

## 7. Conventions (Spotter rules; where they differ from JS8Map 1.75)

These are load-bearing rules, not style preferences.

- **Line endings are LF everywhere**, except **every `.bat`** and `JS8Map.iss`,
  which are CRLF (`.gitattributes`). `debug.bat` was LF in 15a–17d by mistake;
  fixed in 17e.
- **Build tags.** Bump `STATREP_BUILD` and `SR_PAGE_BUILD` together on every
  release (`YYYY-MM-DD` + letter). The box footer warns if they differ. Add a
  CHANGELOG entry (`CHANGELOG_JS8MAPCHAT.txt`, newest first).
- **Release zips are made ONLY with `tools/make_release.py`** (19c). It checks
  the version and both tags agree, runs the tests, zips the folder **leaving out
  operator data** (`*.db` and sidecars, `ham_map_config.json`, `ham_map.html`,
  `boot.js`, `js8_groups.json`, `js8map_server.json`,
  **`js8map_request_token.txt`**, `js8fastchat_intent.json`, logs, caches,
  `build/`, `dist/`) **and the developer's personal launchers**
  (`JS8Map.desktop`, `desktop.ini`), then re-opens the zip and refuses if any
  got in. *Why:* 19a and 19b were zipped by hand and shipped a request token
  that a test run had created in the app folder.
- **Zip name:** `JS8Map_Spotter_Ver_<version>_build_<tag>.zip` (unique per
  build). **Folder inside: `Spotter Mapper Ver <version>`** — it follows
  `APP_VERSION` (1.2 in 17i, **1.76 in 20a**, operator requests) and stays fixed
  between builds of the same version, so the operator unzips over it and
  keeps settings. A version change means a one-time folder rename.
- **One code tree, one zip for Windows and Linux** (since 17g; back to the
  default in 29a, operator's choice after a separate _Windows/_Linux pair in
  20a). Platform code lives in `js8map_platform/`; everything else is shared.
  `make_release.py --platform=windows|linux` still makes per-OS zips
  (`…_Windows.zip` / `…_Linux.zip`, leaving out the other system's scripts);
  `update_linux.sh` never picks a `_Windows` zip.
- **Linux scripts are POSIX `sh`, LF, started with `sh`** (§3.7). The release
  script refuses a zip missing `debug.sh`, `debug.bat`,
  `tools/install_linux_launcher.sh`, `update_linux.sh` or `linux_install.sh`.
- **Page shell vs. script.** `index.html` reaches an open map only after the
  next map rebuild (when it is copied to `ham_map.html`; Data Rebuild, default
  1 min). `app.js`/`app.css` reach it on F5. **Keep live behaviour in app.js**
  — an `onchange` added in index.html (18e) didn't run after an F5 and the
  group chip took ~30 s to clear.
- **Separate product from JS8Map 1.75** (operator decision 2026-10-17):
  - **Windows installer:** `AppId={4D38DDDB-404F-4830-AF15-0825233B8EDF}`
    (**never change it**; 1.75 keeps `8F3A6C21-…`), AppName "JS8Map Spotter",
    AppVersion 1.76, `Program Files\JS8Map Spotter`, shortcuts "JS8Map Spotter"
    with AppUserModelID `KW3KW.JS8MapSpotter`, output
    `installer_output\JS8Map_Spotter_v1.76_Setup.exe`.
  - **Per-user data folder (frozen builds):** `%LOCALAPPDATA%\JS8Map Spotter`,
    `~/.local/share/JS8Map Spotter` (`DATA_FOLDER_NAME`).
  - **Linux package** (`build_linux.sh` → `make_js8map_package.sh`):
    `JS8Map_Spotter_v1.76_build_<tag>_linux.tar.gz`; installs to
    `~/.local/lib/JS8MapSpotter` (§3.7)
    with `js8map-spotter.desktop`, `js8map-spotter-map.desktop` and
    `JS8Map-Spotter.desktop`. Never touches 1.75's files (tested in a throwaway
    home folder).
  - **Window identity:** Tk class `JS8MapSpotter` (WM_CLASS `Js8mapspotter`).
  - **Shared on purpose:** the "JS8MapChat Shared" mailbox and `C:\FCC_DB`.
- **Deliberately unchanged names:** JS8Map.exe and the .spec/.iss file names,
  `js8_spots.db`, `js8map_statrep.db`, the mailbox name, the `js8map_*.py`
  module names.
- **The transmit gate is still singular** (`js8map_tx`). No automatic RRSR acks.
- **The twin gate.** `shared_resolver.py` must stay byte-identical with
  FastChat's copy. `Build_JS8Map.bat` runs `..\check_twins.bat` when it exists
  one folder up; otherwise it warns and skips.
- **Data folder by launch method:** a source run keeps databases and config
  **beside JS8Map.py**; a frozen build uses the per-user folder. Always say
  which one you measured.

---

## 8. Testing and proof

- **Unit tests** in `tests/test_core.py` (**26 tests**, standard library only):
  - parsing: StatRep, alert, ack, partial, doubled prefix, blank grid
  - tags: garble, ack-only, commands
  - datecode decode and round trip; bundled forms decode
  - store: dedup and sources, traffic extension, QSO ack attachment, `rev_tag`,
    payload shape
  - band-activity joining: mid-word split, late-frame double, prefix flush,
    form waiting for its datecode
  - **DataFolder:** a frozen build's data folder is `JS8Map Spotter`
  - **MapWindowTitle:** exact title rule (rejects the Claude app, 1.75's map,
    a browser tab); Linux wmctrl picks Spotter's window over 1.75's
  - **ServerInfo:** `data_dir` points at the spots-db folder (and removes the
    request token the import creates)

  **Add a test with every parser or store change.**
- **`tools/fake_js8call.py`**: stand-in JS8Call API on port 2442. Plays spots,
  a StatRep (N0ASH → @AMRRON), an F!104 (NZ1ON → @SITREP) and a two-frame
  band-activity QSO with an ack (W1AW ⇄ K1ABC). Logs what the app sends.
  Doesn't send a callsign or grid. **The test callsigns are real calls.**
- **`tests/test_linux_scripts.sh`** (29a): `bash tests/test_linux_scripts.sh`
  from the app folder. Builds its own zip, points `HOME` at fresh temp folders,
  and checks 21 cases: install without Tk (fake Python) and with Tk; update
  from a "Ver 1.2" folder keeping `ham_map_config.json`, `js8_spots.db` and the
  operator's own token, ignoring a newer `_Windows` zip, re-pointing the
  launchers; same build; older build (no answer → no change); a token zip
  refused; app running; a zip without executable marks (picks a "(1)" copy);
  both folder names present; a junk zip; the `Spotter*` glob. Needs `unzip`
  and `zip`. **Run it after any change to the scripts.**
- **Cloud test box recipe** (used for 17i–19b): system Python 3.12 +
  `python3-tk`, `Xvfb :99`, `openbox`, `wmctrl`, `xdotool`, Chromium from
  `/opt/pw-browsers` behind a `--no-sandbox` wrapper on PATH as `chromium`.
  Start the fake radio and `./debug.sh`, click Generate Map with xdotool, read
  the port from `~/.local/share/JS8MapChat/Shared/js8map_server.json`, then
  drive the real page with Playwright (`_tblOpen()`, tab clicks, the group
  dropdown) and read state (`_srMarkers`, `_mfMarkers`, `LAYERS`).
  **Box gotchas:** the default `python3` there is 3.13 **without Tk** — use
  `/usr/bin/python3.12` (`PYTHON=python3.12 ./debug.sh`); `pkill -f` patterns
  that appear in your own command line kill your shell — anchor them
  (`pkill -f '^python3.12 JS8Map'`); the container is reclaimed between
  sessions, so nothing in it (zips, test folders) survives — the operator must
  attach the latest zip.
- **`tools/install_linux_launcher.sh`**: menu entry, hidden map-window entry
  (`StartupWMClass=127.0.0.1__ham_map.html`) and a trusted desktop icon, all
  pointing at the current folder's `debug.sh` (or `dist/JS8Map` if a frozen
  build is present). `--remove` takes them out. Re-run after renaming the folder.
- **`tools/make_release.py`**: see §7.
- **Tester material:** `README_TESTERS.txt` (in the zip) and
  `JS8Map_Spotter_1.76_Linux_Install_Guide.docx` (sent separately).

---

## 9. Open items

**Testing still due:**
- **Windows installer:** run `Build_JS8Map.bat`, install
  `JS8Map_Spotter_v1.76_Setup.exe`, check it sits beside JS8Map 1.75 (separate
  Add/Remove entry, icons, data folder) and 1.75 still runs.
- **Linux FastChat:** `data_dir` with the new `db_locator.py`.
- **Linux scripts on the operator's PC:** first update to 29a by hand
  (`unzip -o`, see §3.7), then a later build with `update_linux.sh`; and
  `linux_install.sh` on a clean user account or a tester's PC.
- **Outside testers** on 29a (send the zip with
  `JS8Map_Spotter_1.76_Linux_Install_Guide.docx`).
- **Both PCs:** if still on a "Ver 1.2" folder, the one-time rename to
  `Spotter Mapper Ver 1.76`. Windows: delete the leaked
  `js8map_request_token.txt` if not done with 19c.

**Relay and FastChat (next phase):**
- **The relay bar offers the target itself as a via** (W3BFO and W3BFO/P for
  target W3BFO) and lists stations without a map dot.
- **FastChat:** confirm it POSTs only `/raise_window`; review the remaining
  `Access-Control-Allow-Origin: *` on GET replies; re-check the twin; decide
  on `js8map_alive_poller.py`.
- ~~`js8map_fastchat.py` "from KW3KW" fallback~~: blank since 2026-11-12.
- **app.js lint in the relay code:** `_relayStatusPopup` assigned without a
  declaration; `var bar` declared twice in `_updateOutcomeBar`.

**Structure (now that tests exist):**
- Split `js8map_statrep.py`; replace `js8map_web.py`'s `wire()` globals and
  if-chains with a context object and a route table; split `app.js` by
  feature (now ~170 global functions); replace the `toggleStatRepTable` /
  `_srShowTab` monkey-patch with an event hook; inherited giants
  (`_handle_line`, `build_stations_from_db`, `_build_ui`); ~210 broad
  `except Exception` and no `logging`.
- **Request token at import time:** `js8map_web` creates the token file when
  imported. Consider creating it lazily (first render) so imports have no side
  effects.

**GitHub (repository opened 2026-11-12):**
- **Done:** own repository with the program at the top level; LICENSE GPL-3.0;
  README.md; NOTICE.md (Leaflet 1.9.4 BSD-2, MCForms forms KF7MIX / SitRepNet,
  FCC, ISED, GeoNames CC BY 4.0, CARTO / OpenStreetMap); `debug.bat` no longer
  names KW3KW's Python (uses `py`, then `python`, or `PYEXE` if set);
  `js8map_fastchat.py` "from KW3KW" fallback is now blank; `.git` left out of
  release zips; build output added to `.gitignore`; TCP Max Connections 5
  everywhere; `BUILD_NOTES.txt` and `INSTALL_FastChat_Button.txt` moved to
  `dev/history/`.
- **Still to do:** record the source of the border, lakes, admin-1 and places
  JSON in NOTICE.md; ask KF7MIX / SitRepNet that bundling the forms is OK;
  made-up callsigns in the fake radio.
- **GitHub build (29f, 2026-11-20):** `.github/workflows/tests.yml` runs both
  test sets on Ubuntu 22.04 on every push; `.github/workflows/release.yml`
  builds the Windows Setup.exe and portable zip (`tools/build_windows.py`) and
  the Linux package (`build_linux.sh`, Ubuntu 22.04) when a release is
  published, and attaches them with the guide PDFs from `docs/`. Release notes
  come from the top section of `CHANGELOG.md`.
- **`update_linux.sh` Downloads fix (GitHub only, 2026-11-20):** when no
  Downloads folder is set up, `xdg-user-dir DOWNLOAD` answers with the home
  folder, so the script looked for the zip in `~` instead of `~/Downloads`; it
  now falls back to `~/Downloads`. Found by the first GitHub test run (15 of the
  28 checks failed there). Bring this file back to the app's project.
- **Twin across repositories.** `shared_resolver.py` is now in two repositories.
  `Build_JS8Map.bat` looks for `..\check_twins.bat`, which only exists in
  JS8MapChat, so in this repository it warns and skips. Check by hand before a
  release, or point JS8FastChat's `tools/twin_path.txt` at this repository's
  `shared_resolver.py`.

**Feature ideas:**
- **Net view:** spot a busy @group, mark net control, draw spokes to the
  check-ins, show a roster.
- **JS8Spotter import of ordinary messages.**
- **A "Create desktop icon" button** in the app or the wizard.
- **Header text** is cut short ("JS8Map Spotter Ve…") at ~1600 px while Return
  to Map shows; drop Grid or the version from that line while a table is open.
