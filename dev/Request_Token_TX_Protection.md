# JS8Map Spotter – request token (TX protection)

**Status:** shipped in build **2026-10-15a**.
- Tested on Linux, from source and as a frozen build: the map's buttons work, a POST without the token gets 403, and another website's request never reached JS8Call.
- Windows with real JS8Call, from source (Ver 1.2/1.76, builds 17e–19b): the map and FastChat hand-off run with the token on. The popup send buttons have not been specifically checked on Windows yet.
- **Incident:** builds 19a and 19b shipped a token in the zip. See the last section.

**Decided:** 2026-10-15, session "JS8Spotter Map Build Out #2".

## Why

The map window is a web page. Its buttons (SNR?, HEARING?, MSG, Send, HALT, relay) POST to JS8Map Spotter's built-in web server at `http://127.0.0.1:<random port>`, and the server passes them to JS8Call.

Up to build 14s, the server accepted these requests from **any** web page and sent `Access-Control-Allow-Origin: *`. Suppose a website open in the operator's browser found the port. It could send a request just like the map page's, and in live mode JS8Call would transmit its text under the operator's callsign. In manual mode it would fill JS8Call's text box instead.

The Go LIVE dialog does not cover this, because the request arrives after it has been answered. The risk is low (it needs a targeted page and a port scan), but the code will be public on GitHub.

## What it does (operator sees nothing)

1. **One secret, made once.** `js8map_runtime.load_or_create_request_token()` makes a random 32-character secret on first start. It saves it in the data folder as `js8map_request_token.txt` (owner-only on Linux) and reuses it on every later start.
   - It persists so that long sessions and restarts never break an open map window.
   - A web page cannot read files on the PC.
   - **Note:** the token is created when `js8map_web` is **imported** (`_REQ_TOKEN` at module level), not at first render. Anything that imports the module — including a test — writes the file into the data folder, which for a source tree is the app folder.
2. **Put in the map page.** `render_html` (js8map_web.py) writes it into `boot.js` as `JS8MAP_BOOT.req_token`.
3. **Sent with every POST.** At the top of app.js, `_tokenFetch()` wraps `window.fetch` once. Every POST to the page's own server gets the header `X-JS8Map-Token`, so no call site was changed (relay and FastChat code untouched).
4. **Checked by the server.** `do_POST` calls `_post_allowed()`, which uses `hmac.compare_digest`. A missing or wrong token gets **403** with the body `403 token`, and nothing runs.
5. **"Any website" header removed.** `Access-Control-Allow-Origin: *` comes off the POST replies, and the OPTIONS reply sends no CORS headers. The map page is served by the same server, so it needs neither.
   - Some GET replies (`/focus`, `/refresh`, relay and FastChat status) still carry the `*` header. They only read data or raise the window. They'll be revisited in the FastChat/relay phase.

### Which requests are protected

- **Protected:** every POST except `/raise_window`. That covers:
  - `/popup_tx`, `/halt_tx`
  - `/relay_commit`, `/relay_switch_path`, `/relay_active`, `/relay_arm_clear`, `/relay_outcome_clear`
  - `/fastchat_handoff`, `/raise_window_fastchat`
  - `/statrep_import`, `/set_fit_exclusion`, `/refresh` (POST)
- **Left open:**
  - `/raise_window` (in `_TOKEN_EXEMPT_POSTS`). The separate JS8FastChat program POSTs it, it has no token, and it only brings the window to the front.
  - All GET requests.
  - **FastChat phase:** confirm that FastChat doesn't POST anything else to JS8Map. If it does, give FastChat the token by reading the file, or add that path to the exempt list.

### Old map window after an upgrade

On a 403, the fetch wrapper reloads the page **once**, which picks up the current `boot.js`.
- A `sessionStorage` key (`js8map_token_reload`) stops it from looping.
- The key is cleared after the next successful POST.

## Settings

Kept in `ham_map_config.json` and read at startup:

| Setting | Default | Meaning |
|---|---|---|
| `require_request_token` | `true` | `false` turns the check off completely. This restores the build 14s behaviour without a rebuild. |

To get a new secret, close the program, delete `js8map_request_token.txt` from the data folder, and start again. An open map window reloads itself once. The data folder is the app folder for a source run, or the per-user **`JS8Map Spotter`** folder for an installed build (`%LOCALAPPDATA%\JS8Map Spotter`, `~/.local/share/JS8Map Spotter`; it was "JS8Map" before Spotter Ver 1.2).

## Troubleshooting

- **Buttons do nothing / 403:** reload the map window (F5). Check that `boot.js` contains `req_token` and that it matches `js8map_request_token.txt`.
- **The FastChat → JS8Map button stops working:** `/raise_window` must stay in `_TOKEN_EXEMPT_POSTS`.
- **To rule the token out:** set `require_request_token` to `false`, restart, and test again.

## How to undo it completely

1. Set `require_request_token: false`. That alone disables it.
2. For a code rollback, remove these (all marked "REQUEST TOKEN" in comments):
   - js8map_web.py: `_REQ_TOKEN`, `_post_allowed`, `_TOKEN_EXEMPT_POSTS`, and the 403 branch in `_do_post`. Restore the `Access-Control-Allow-Origin` header on POST/OPTIONS if anything outside the page needs it.
   - js8map_web.py `render_html`: the `req_token` boot key.
   - js8map_runtime.py: `REQUEST_TOKEN_FILE`, `load_or_create_request_token()`, and the `require_request_token` default.
   - app.js: the `_tokenFetch()` block near the top.
3. Delete `js8map_request_token.txt` from the data folder. It's optional.

## Files touched

- js8map_runtime.py
- js8map_web.py
- app.js
- .gitignore (`js8map_request_token.txt`)
- Release zips exclude the token file — **enforced by `tools/make_release.py` since 19c** (it re-opens the zip and refuses if the token is in it).

## Incident: token shipped in 19a and 19b (found 2026-10-19, fixed in 19c)

**What happened:** the release zips for builds 2026-10-19a and 2026-10-19b contained `js8map_request_token.txt`.
- **Cause:** the 19a `ServerInfo` test imports `js8map_web`, and importing that module creates the token in the data folder. For a source tree the data folder is the app folder. The folder was then zipped by hand, without checking the exclusion list.
- **Effect:** anyone who unzipped 19a/19b over their folder had their own token replaced by the same, published one. Only the operator's two PCs got those builds; neither was sent to anyone else.

**Fixed in 19c:**
- The test removes a token it created.
- **`tools/make_release.py` is now the only way to make a release zip.** It leaves out operator data and personal files and **re-opens the zip and refuses** if `js8map_request_token.txt`, `ham_map_config.json` or any `.db` file got in.

**Since 29a, `update_linux.sh` also refuses** any zip that contains a token, settings or a database, so a 19a/19b zip left in Downloads can't be installed by accident.

**Clean-up on a PC that ran 19a or 19b:** close Spotter, delete `js8map_request_token.txt` from the data folder, and start Spotter. A new private token is made, and an open map window reloads itself once.
- Linux PC: done 2026-10-19.
- Windows PC: still to do when 19c goes on.

**Possible follow-up:** create the token lazily (on first render) instead of at import, so importing `js8map_web` has no side effects.
