/* ══════════════════════════════════════════════════════════════════════
   JS8Map app.js  —  extracted verbatim from MAP_HTML (v1.79_H).
   The ONLY edits vs the original inline <script>: the ~15 Python {tokens}
   in the preamble now read from window.JS8MAP_BOOT (defined in boot.js,
   which loads first). All JS-runtime placeholders are untouched.
   ══════════════════════════════════════════════════════════════════════ */
(function _hydrateBoot(){
  var B = window.JS8MAP_BOOT || (window.JS8MAP_BOOT = {});
  // Header text (was {callsign}/{grid}/{generated} substituted into the body)
  var set = function(id,v){ var el=document.getElementById(id); if(el) el.textContent=v; };
  set('hdr-call', B.callsign || 'MY STATION');
  set('hdr-grid', B.grid || '????');
  set('hdr-gen',  B.generated || '');
  try { document.title = (B.callsign ? B.callsign + ' \u00b7 ' : '') + 'JS8Map Spotter'; } catch(e){}
  // Group-color rules (was {group_css}) — per-render dynamic, inject now
  var gcss = document.getElementById('js8map-group-css');
  if (gcss) gcss.textContent = B.group_css || '';
  // Group filter <option>s (was {group_filter_opts})
  var sel = document.getElementById('group-filter');
  if (sel && B.group_filter_opts) sel.insertAdjacentHTML('beforeend', B.group_filter_opts);
})();

/* ── REQUEST TOKEN (build 15a) ─────────────────────────────────────────────
   Every POST to this page's own server carries the secret from boot.js, so
   only this page can send / transmit (see js8map_web.py "REQUEST TOKEN").
   Done once here by wrapping fetch, so no call site needs to know about it.
   A 403 means the page is older than the running program (e.g. opened by a
   pre-15a build): reload once to pick up the current boot.js. */
(function _tokenFetch(){
  var _fetch = window.fetch.bind(window);
  var TOKEN = (window.JS8MAP_BOOT || {}).req_token || '';
  window.fetch = function(input, init){
    init = init || {};
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    var sameOrigin = url.charAt(0) === '/' || url.indexOf(location.origin + '/') === 0;
    if (method === 'POST' && sameOrigin) {
      var h = new Headers(init.headers || {});
      h.set('X-JS8Map-Token', TOKEN);
      init = Object.assign({}, init, {headers: h});
      return _fetch(input, init).then(function(r){
        if (r.status === 403) {
          var k = 'js8map_token_reload';
          var done = false;
          try { done = sessionStorage.getItem(k) === location.pathname; } catch(e){}
          if (!done) {
            try { sessionStorage.setItem(k, location.pathname); } catch(e){}
            location.reload();
          }
        } else if (r.ok) {
          // token accepted: re-arm the one-time reload for a later restart
          try { sessionStorage.removeItem('js8map_token_reload'); } catch(e){}
        }
        return r;
      });
    }
    return _fetch(input, init);
  };
})();

const $ = id => document.getElementById(id); /* shorthand — used throughout */
/* ── Feature colors (generated from Python COLORS dict — single source of truth) ── */
const COLORS = JS8MAP_BOOT.COLORS;
/* ── Zoom-responsive label size config (from Python LABEL_SIZE) ── */
const LABEL_SIZE = JS8MAP_BOOT.LABEL_SIZE || {min_px:9,max_px:22,min_zoom:3,max_zoom:11};
/* ── Data ── */
const MY_LAT   = JS8MAP_BOOT.my_lat;
const MY_LON   = JS8MAP_BOOT.my_lon;
const MY_CALL  = JS8MAP_BOOT.callsign;
const MY_GRID  = JS8MAP_BOOT.grid;
const STATIONS = JS8MAP_BOOT.stations;
/* RELAY_PATHS: {target_call: [{via, snr, timestamp, age_min, confidence}]} */
const RELAY_PATHS = JS8MAP_BOOT.relay_paths;

// Fit All geographic zone — USA, Canada, Caribbean.
// Stations outside this box are excluded from the Fit bounding box
// but remain fully visible on the map.
const FIT_LAT_MIN = 15,  FIT_LAT_MAX = 75;
const FIT_LON_MIN = -170, FIT_LON_MAX = -50;
// Per-callsign manual fit exclusions (persisted in config, toggled via popup).
const FIT_EXCLUSIONS = new Set(JS8MAP_BOOT.fit_exclusions);

// ── Short-path line endpoint (antimeridian-aware) ───────────────────────────
// A Leaflet polyline is drawn straight in the flat (equirectangular) map, so a
// line from the operator to a station on the far side of the world goes the
// LONG way across the map instead of the short (great-circle) way. For hams
// that's misleading: it implies the wrong bearing/path.
//
// Fix, location-independent (keys off the operator's own longitude MY_LON, so
// it's correct for a US, EU, VK, or any other operator): if the station is more
// than 180° of longitude away in the flat sense, shift its longitude by ±360°
// so the line is drawn toward the nearer "copy" of the station -- i.e. off the
// correct map edge, wrapping the short way. Leaflet renders longitudes beyond
// ±180 fine, continuing the world horizontally, which is exactly the wrap we
// want. Only the LINE endpoint is shifted; the marker still sits at the real
// position. Stations within 180° (Europe, Africa, South America from the US,
// etc.) are unchanged.
function _shortPathEnd(lat, lon){
  let d = lon - MY_LON;
  // Normalize the difference into (-180, 180]; if the raw flat difference was
  // outside that, the shifted longitude sends the line the short way.
  let shiftedLon = lon;
  if(d > 180)  shiftedLon = lon - 360;
  else if(d < -180) shiftedLon = lon + 360;
  return [lat, shiftedLon];
}

// Via-indexed lookup for station popups
const RELAY_BY_VIA = {};
for(const [tgt, arr] of Object.entries(RELAY_PATHS)){
  for(const p of arr){
    if(!RELAY_BY_VIA[p.via]) RELAY_BY_VIA[p.via]=[];
    RELAY_BY_VIA[p.via].push({target:tgt,snr:p.snr,snr_to_me:p.snr_to_me,
      composite:p.composite,age_min:p.age_min,confidence:p.confidence});
  }
}

// Live relay polling — fetch /relay.json every 10s so relay toolbar
// updates automatically without a page reload.
let _liveRelay = {};
// Declare relay filter state here — before mkPopup and STATIONS loop
// so they are never in the Temporal Dead Zone when referenced.
let _relayTarget = '';
let _relayLineColors = {};
// ── Relay chain state (B.15) ─────────────────────────────────────────
let _chainVia       = null;   // via callsign currently selected in banner
let _chainTarget    = null;   // relay target callsign (= _relayTarget when chain active)
let _chainTargetPos = null;   // {lat,lon,grid} from armed_target_pos in data.json
let _chainCommitted = false;  // true after GO is pressed — locks selection
let _lastArmedTarget= null;   // tracks last armed_target seen from data.json
let _chainLegs      = [];     // Leaflet polylines for legs 1 & 2
let _chainMarker    = null;   // Leaflet marker for target station
let _chainMsgPrefix = '';     // C.18: last copied relay prefix for Switch Path
// ── Phase 2: relay chain animation state ─────────────────────────────────────
let _relayAnimState = null;   // last processed state string
let _relayAnimStops = [];     // rAF cancel functions
let _relayAnimLegs  = [];     // comet Leaflet polylines
function _pollRelay(){
  fetch('/relay.json?_='+Date.now())
    .then(r=>r.json())
    .then(data=>{
      _liveRelay = data;
      // Merge new paths into RELAY_BY_VIA
      for(const [tgt, arr] of Object.entries(data)){
        for(const p of arr){
          if(!RELAY_BY_VIA[p.via]) RELAY_BY_VIA[p.via]=[];
          if(!RELAY_BY_VIA[p.via].some(x=>x.target===tgt))
            RELAY_BY_VIA[p.via].push({target:tgt,snr:p.snr,snr_to_me:p.snr_to_me,
              composite:p.composite,age_min:p.age_min,confidence:p.confidence});
        }
      }
      // Refresh relay banner if filter is active
      if(_relayTarget) applyRelayFilter(_relayTarget);
    })
    .catch(()=>{});
  setTimeout(_pollRelay, 10000);
}
_pollRelay();

/* GENERATE_TS: timestamp of this map generation — used to detect new maps */
const GENERATE_TS = JS8MAP_BOOT.generate_ts;
let _txHaltEnabledLive = !!JS8MAP_BOOT.tx_halt_enabled;  // updated by data poll when toggled in settings

/* ── Zoom/theme/labels persistence via sessionStorage ── */
const SS = window.sessionStorage;
const savedZoom   = SS.getItem('map_zoom');
const savedLat    = SS.getItem('map_lat');
const savedLon    = SS.getItem('map_lon');
const savedTheme  = SS.getItem('map_theme')  || 'dark';
const savedLabels = SS.getItem('map_labels') !== 'false';
const savedPopup  = SS.getItem('map_popup') || 'full';             // default Full
let   _animEnabled = SS.getItem('map_anim') !== 'false';            // relay animation on by default

const initCenter = (savedLat && savedLon) ? [+savedLat, +savedLon] : [MY_LAT, MY_LON];
const initZoom   = savedZoom ? +savedZoom : 4;

/* ── Map init ── */
const map = L.map('map', {center:initCenter, zoom:initZoom, zoomControl:true,
  zoomSnap:0.5, zoomDelta:0.5});

// Enable clicks on permanent tooltip labels — Leaflet sets tooltipPane to
// pointer-events:none by default; re-enable it and use event delegation so
// clicking .label-box opens that station's popup without touching the dot.
// Enable tooltip pane clicks immediately — pane is created synchronously by L.map()
(function(){
  var pane = map.getPane('tooltipPane');
  if(!pane) return;
  pane.style.pointerEvents = 'auto'; // enable pane; .station-label stays none, .label-box is auto
  pane.addEventListener('click', function(e){
    var box = e.target.closest('.label-box');
    if(!box) return;
    var call = box.getAttribute('data-call');
    var entry = LAYER_MAP[call];
    if(entry && entry.marker){
      e.stopPropagation();
      entry.marker.openPopup();
    }
  });
})();

// B.15: ESC exits relay/chain entirely
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&(_relayTarget||_chainVia||_chainCommitted)){
    e.preventDefault(); clearChain();
  }
});

/* ── Zoom-responsive label sizing ── */
function updateLabelSize(){
  const z = map.getZoom();
  // Linear interpolation between zoom endpoints, clamped to [min_px, max_px]
  let t = (z - LABEL_SIZE.min_zoom) / (LABEL_SIZE.max_zoom - LABEL_SIZE.min_zoom);
  t = Math.max(0, Math.min(1, t));
  const size = Math.round(LABEL_SIZE.min_px + t * (LABEL_SIZE.max_px - LABEL_SIZE.min_px));
  // Padding scales with font so the whole box shrinks/grows together
  const padV = Math.max(1, Math.round(size * 0.32));
  const padH = Math.max(3, Math.round(size * 0.72));
  // Notif badges/slots scale proportionally too. Sized noticeably larger than
  // the callsign font (v1.82_E) so the heard-by/hears counts are easy to read
  // at normal zoom — they were ~10px circles with a ~7px digit before.
  const slot = Math.max(16, Math.round(size * 1.5));
  const slotFont = Math.max(10, Math.round(slot * 0.64));
  const sheet = $('label-zoom-style');
  if(sheet) sheet.textContent =
    `.label-box{font-size:${size}px!important;padding:${padV}px ${padH}px!important;` +
    `font-family:var(--font-main)!important;}` +
    `.notif-slot{width:${slot}px!important;height:${slot}px!important;` +
    `font-size:${slotFont}px!important;}`;
}
updateLabelSize();  // apply once right away so labels start correctly sized (and can't be skipped by a later error)
/* ── User-movement tracking — gates expand-only fit for new arrivals ──
   Listens to actual DOM input events (mousedown, wheel, touchstart) on
   the map container. These are physically impossible to trigger from
   code, so no suppression flag is needed. Any click, drag, scroll, or
   touch on the map sets _userHasMoved = true. fitAll() resets it.    */
let _userHasMoved   = false;
let _programmaticFit = false;   // true while a code-driven fit animates

(function(){
  const mc = map.getContainer();
  const _set = ()=>{ _userHasMoved = true; };
  mc.addEventListener('mousedown',  _set);
  mc.addEventListener('wheel',      _set, {passive:true});
  mc.addEventListener('touchstart', _set, {passive:true});
})();

// Robust user-intent tracking: Leaflet fires zoomstart/dragstart for EVERY
// zoom/pan method (wheel, +/- buttons, pinch, double-click, keyboard) — catch
// them all here, but ignore code-driven fits guarded by _programmaticFit.
map.on('zoomstart dragstart', function(){
  if(!_programmaticFit) _userHasMoved = true;
});

// Wrap a code-driven fit so it doesn't trip _userHasMoved. Sets the guard,
// runs the fit, then clears the guard after the animation settles.
function _beginProgrammaticFit(){
  _programmaticFit = true;
  setTimeout(function(){ _programmaticFit = false; }, 1100);
}

map.on('zoom zoomend', updateLabelSize);  // live while zooming + final — smooth scaling
map.on('moveend zoomend', () => {
  const c = map.getCenter();
  SS.setItem('map_zoom', map.getZoom());
  SS.setItem('map_lat',  c.lat);
  SS.setItem('map_lon',  c.lng);
});

/* ── Keyboard shortcuts ───────────────────────────────────────
   Leaflet built-ins (no code needed):
     +  /  =    Zoom in
     -          Zoom out
     Arrow keys Pan the map
     Shift+drag Zoom to rectangle

   Custom shortcuts:
     F   → Fit All (zoom to show all stations)
     R   → Refresh HTML map
     /   → Focus callsign search box
     L   → Toggle station labels
     D   → Toggle dark / light theme
     1   → Filter: All stations
     2   → Filter: I Hear (blue)
     3   → Filter: Mutual (orange)
     4   → Filter: Via Heartbeat
     Esc → Close popup · clear search · restore all stations
   ─────────────────────────────────────────────────────────── */

// Toast notification for shortcut feedback
function _kbToast(msg, dur){
  let t = $('_kb-toast');
  if(!t){
    t = document.createElement('div');
    t.id = '_kb-toast';
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);'
      +'background:rgba(20,40,60,0.92);color:#d0dce8;font-family:var(--font-main);'
      +'font-size:13px;font-weight:700;padding:7px 18px;border-radius:20px;'
      +'border:1px solid rgba(255,255,255,0.15);pointer-events:none;'
      +'z-index:9999;opacity:0;transition:opacity .15s;white-space:nowrap;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.opacity = '0'; }, dur || 1200);
}

document.addEventListener('keydown', function(e){
  // Esc always works — closes popup, clears search, restores all stations
  if(e.key === 'Escape' || e.key === 'escape'){
    e.preventDefault();
    map.closePopup();
    const s = $('search');
    if(s){
      s.value = '';
      s.blur();
      const clr = $('search-clear');
      if(clr) clr.style.display = 'none';
    }
    // Also clear relay filter
    const rs = $('relay-search');
    if(rs && rs.value){ rs.value=''; applyRelayFilter(''); }
    // Cancel draw box mode
    if(_boxMode) toggleDrawBox();
    applyFilters();
    return;
  }
  // Other shortcuts: don't fire when typing in search/input
  if(e.target && (e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA')) return;
  if(e.ctrlKey || e.altKey || e.metaKey) return;
  const key = e.key.toLowerCase();

  if(key==='f'){
    e.preventDefault();
    fitAll();
    _kbToast('⛶  Fit All');
    $('fitall-btn').style.borderColor='var(--blue)';
    setTimeout(()=>{ $('fitall-btn').style.borderColor=''; }, 600);

  } else if(key==='r'){
    e.preventDefault();
    _kbToast('🔄  Refreshing data…');
    fetch('/refresh').catch(function(){});   // ask Python to pull from JS8Call & rebuild now
    _pollData();                             // re-read immediately
    setTimeout(_pollData, 800);              // again once the rebuild has landed
    setTimeout(_pollData, 1800);             // and once more to be safe
    if(typeof _pollRelay === 'function') setTimeout(_pollRelay, 900);

  } else if(key==='/'){
    e.preventDefault();
    const s = $('search');
    if(s){ s.focus(); s.select(); }
    _kbToast('🔍  Find callsign');

  } else if(key==='l'){
    e.preventDefault();
    toggleLabels();
    _kbToast(showLabels ? '🏷  Labels On' : '🏷  Labels Off');

  } else if(key==='d'){
    e.preventDefault();
    toggleStyle();
    _kbToast(currentStyle==='dark' ? '🌙  Dark Theme' : '☀  Light Theme');

  } else if(key==='1'){
    e.preventDefault();
    quickFilter('all');
    _kbToast('📍  Show: All Stations');

  } else if(key==='2'){
    e.preventDefault();
    quickFilter('heard');
    _kbToast('🔵  Show: I Hear');

  } else if(key==='3'){
    e.preventDefault();
    quickFilter('both');
    _kbToast('🟠  Show: Mutual');

  } else if(key==='4'){
    e.preventDefault();
    quickFilter('via_hb');
    _kbToast('📡  Show: Via Heartbeat');

  } else if(key==='+' || key==='='){
    e.preventDefault();
    map.zoomIn();
    _kbToast('🔍  Zoom In');

  } else if(key==='-'){
    e.preventDefault();
    map.zoomOut();
    _kbToast('🔎  Zoom Out');
  }
});

/* ── Tile layers — OPTIONAL street detail, not the map itself ──────────────
   The map proper is drawn from bundled borders and place names below, so it
   works with no internet at all. Tiles are extra detail underneath that, and
   are only requested when the operator has entered their own provider key.

   No key means NO request is made. CARTO now stamp "API KEY REQUIRED" across
   unkeyed tiles, and a spoiled backdrop is worse than none. Python decides:
   it sends empty URLs when there is no key, and we simply skip the layer. */
/* Cache-buster for the four map-data files. They are fetched by name, so the
   stamp Python adds to the page's own <script> and <link> tags never reaches
   them -- without this an operator who updates keeps the OLD borders and
   place names until they know to press Ctrl+F5, which they will not. */
const _CACHE_TAG = JS8MAP_BOOT.asset_tag ? ('?v=' + JS8MAP_BOOT.asset_tag) : '';

const _TILE_ATTR  = (JS8MAP_BOOT.tile_attribution || '');
const _TILE_LIGHT = (JS8MAP_BOOT.tile_url_light   || '');
const _TILE_DARK  = (JS8MAP_BOOT.tile_url_dark    || '');

function _mkTiles(url){
  if(!url) return null;                       // no key configured — draw nothing
  return L.tileLayer(url, {
    attribution: _TILE_ATTR, maxZoom: 19, subdomains: 'abcd',
    // Tiles sit UNDER the borders and stations. Without this a slow or failed
    // tile fetch could paint over the map that is already drawn.
    pane: 'tilePane',
    // An unreachable tile server (offline, or a wrong URL) must not leave
    // broken-image boxes across the map. Leaflet keeps the pane empty instead.
    errorTileUrl: ''
  });
}

const TILES = { light: _mkTiles(_TILE_LIGHT), dark: _mkTiles(_TILE_DARK) };

let currentStyle = savedTheme;
if(TILES[currentStyle]) TILES[currentStyle].addTo(map);
if(currentStyle === 'light') {
  document.body.classList.add('light-theme');
  $('map-style-btn').textContent = '🌙 Dark Map';
} else {
  $('map-style-btn').textContent = '☀️ Light Map';
}

/* ── Phase 2: relay animation poll — must be after map init ── */
function _pollRelayAnim() {
  fetch('/relay_anim.json?_='+Date.now())
    .then(function(r){ return r.json(); })
    .then(function(data){
      // C.18: response is now {anim, outcome}
      var anim    = data.anim    || null;
      var outcome = data.outcome || null;
      if(anim && anim.state && anim.state !== _relayAnimState && _animEnabled){
        _relayAnimState = anim.state;
        _handleRelayAnim(anim);
      }
      _updateOutcomeBar(outcome);
    })
    .catch(function(){});
  setTimeout(_pollRelayAnim, 1000);
}
_pollRelayAnim();

/* ── Bold boundary overlay (GeoJSON) ── */
let boundaryLayer = null;
let boundaryGlow  = null;

/* World coastlines and country borders, plus state/province lines, are now
   shipped in the installer and served by JS8Map itself. They used to be
   fetched from two files on GitHub on every single map open, which meant a
   station with no internet got no borders at all — and, with the library
   also coming from a CDN, no map whatsoever. These are the whole world, not
   just North America: JS8 goes everywhere and so does the map. */
let _geoCache = null;           // borders + admin1 + lakes, fetched once

function _loadGeo(){
  if(_geoCache) return _geoCache;
  const j = f => fetch(f + _CACHE_TAG).then(r=>r.json()).catch(()=>null);
  _geoCache = Promise.all([
    j('js8map_borders.json'), j('js8map_admin1.json'), j('js8map_lakes.json')
  ]).then(([borders, admin1, lakes]) => ({borders, admin1, lakes}))
    .catch(()=> null);
  return _geoCache;
}

/* Station lines sit UNDER the boundary layer group, because that group is
   added inside a _loadGeo().then() -- i.e. after the station lines already
   exist -- and its first layer is an opaque land fill (fillOpacity:1). The
   lines are still attached and still drawn; they are simply painted over.
   Lifting them back to the front is the whole fix. Called from inside
   addBoundaries so it also runs on a theme change, which rebuilds the
   boundaries a second time.

   The previous boundary layer used fill:false and could not cover anything,
   which is why this only started with the offline map. */
function _liftStationLines(){
  // The geo files can finish loading before the station loop has run, in
  // which case there is nothing to lift yet -- and nothing to fix either,
  // since lines created after this point are already on top.
  if(typeof LAYERS === 'undefined' || !LAYERS) return;
  LAYERS.forEach(function(l){
    if(l && l.line && map.hasLayer(l.line)) l.line.bringToFront();
  });
}

/* ── Wrapped world ──────────────────────────────────────────────
   The CARTO tile layer repeated the world horizontally for free -- that is
   what a tile layer does -- so Australia also appeared WEST of the Americas
   and a Pacific path simply ran there. The offline basemap (§4.10) is drawn
   from GeoJSON, and GeoJSON is drawn exactly once. Nothing repeats.

   That is what broke the Pacific paths. _shortPathEnd() shifts a far-side
   endpoint by ±360° to aim at the nearer copy of the station, which was
   correct against tiles and aimed at empty space afterwards. Measured on
   KW3KW 2026-09-02: an Australian marker at container x=3571, the line's
   endpoint at x=-525 -- one full world width (4096 px) apart, off the drawn
   map. The line was right; the world it pointed at was missing.

   So the basemap is drawn three times, at -360, 0 and +360. The world
   repeats either side, _shortPathEnd becomes correct again as written, and
   a VK/ZL/JA path lands on real land. Both directions, not just west: a VK
   or JA operator running this crosses the antimeridian the other way.

   Cost measured on KW3KW before this was written: 202 ms to shift and 117 ms
   to render one extra copy of the borders file, one time at load, and panning
   and zooming stayed smooth. Shifted copies are cached per source object, so
   a theme change (which calls addBoundaries again) does not re-shift. */
const WORLD_COPIES = [-360, 0, 360];
const _shiftCache  = new WeakMap();

function _shiftGeo(geo, deg){
  if(!geo || !deg) return geo;
  let byDeg = _shiftCache.get(geo);
  if(!byDeg){ byDeg = {}; _shiftCache.set(geo, byDeg); }
  if(byDeg[deg]) return byDeg[deg];
  const out = JSON.parse(JSON.stringify(geo));
  (out.features || []).forEach(function(f){
    if(f && f.geometry && f.geometry.coordinates){
      (function walk(c){
        if(typeof c[0] === 'number'){ c[0] += deg; return; }
        for(let i=0;i<c.length;i++) walk(c[i]);
      })(f.geometry.coordinates);
    }
  });
  byDeg[deg] = out;
  return out;
}

function addBoundaries(isDark) {
  if(boundaryLayer) { map.removeLayer(boundaryLayer); boundaryLayer = null; }
  if(boundaryGlow)  { map.removeLayer(boundaryGlow);  boundaryGlow  = null; }
  // Borders carry the map now that there is no tile backdrop, so they are
  // drawn firmly. Land is filled a shade off the page background so land and
  // water read as different things -- without a fill the whole world was one
  // flat colour and only the outlines told you where the coast was.
  // Land is the FILL; the ocean is the map container behind it, coloured in
  // app.css (.leaflet-container). Getting that wrong is what made the dark
  // map's ocean come out near-white: nothing was setting it, so Leaflet's own
  // default light-grey showed through everywhere land was not drawn.
  // Lakes are painted in the same colour as the ocean so water reads as water.
  const landFill   = isDark ? '#0f141b' : '#faf8f4';
  const waterFill  = isDark ? '#1b2530' : '#cfe1ee';
  const natColor   = isDark ? 'rgba(200,222,245,0.60)' : 'rgba(35,55,95,0.62)';
  const subColor   = isDark ? 'rgba(175,200,228,0.32)' : 'rgba(55,80,120,0.34)';
  const lakeStroke = isDark ? 'rgba(150,185,220,0.30)' : 'rgba(70,110,150,0.40)';

  _loadGeo().then(geo => {
    if(!geo || !geo.borders) return;
    const layers = [];
    // Drawn once per world copy so the map repeats east and west. Within each
    // copy: land fill first, then lakes punched over it, then the lines on top.
    WORLD_COPIES.forEach(function(off){
      const bd = _shiftGeo(geo.borders, off);
      const lk = geo.lakes  ? _shiftGeo(geo.lakes,  off) : null;
      const a1 = geo.admin1 ? _shiftGeo(geo.admin1, off) : null;
      layers.push(L.geoJSON(bd, {style:{color:natColor, weight:0.9,
        fill:true, fillColor:landFill, fillOpacity:1, opacity:0}}));
      if(lk) layers.push(L.geoJSON(lk, {style:{color:lakeStroke,
        weight:0.6, fill:true, fillColor:waterFill, fillOpacity:1, opacity:1}}));
      if(a1) layers.push(L.geoJSON(a1,
        {style:{color:subColor, weight:0.9, fill:false, opacity:1}}));
      layers.push(L.geoJSON(bd, {style:{color:natColor, weight:1.1,
        fill:false, opacity:1}}));
    });
    boundaryLayer = L.layerGroup(layers).addTo(map);
    // Lift the station lines back above the land fill just added. Without
    // this they are invisible from page load until something happens to
    // re-add them. See _liftStationLines above.
    _liftStationLines();
  }).catch(()=>{});
}
addBoundaries(currentStyle === 'dark');

/* ── Place names (country / state / city) ──────────────────────────────────
   Also shipped in the installer. Each label carries the zoom at which it
   starts being drawn, worked out from feature size and city population, so a
   whole-world view shows a readable scatter rather than a wall of text and a
   regional view fills in. Purely for orientation — no counties, no streets. */
let _placeLayer = null;
let _placeData  = null;
let _placesOn   = (JS8MAP_BOOT.show_place_labels !== false);

function _placeClass(kind){
  return kind === 'country' ? 'pl-country'
       : kind === 'state'   ? 'pl-state'
       : 'pl-city';
}

function _drawPlaces(){
  if(!_placesOn || !_placeData) {
    if(_placeLayer){ map.removeLayer(_placeLayer); _placeLayer = null; }
    return;
  }
  const z = map.getZoom();
  // Only build labels for what is actually on screen.
  const b = map.getBounds().pad(0.15);
  // Collision filter. Without this, Winston-Salem, Greensboro and Burlington
  // all landed on each other around the Triad and the map became unreadable.
  // Labels are placed in priority order -- countries, then states, then cities
  // biggest first -- and any that would overlap something already placed is
  // simply dropped. This is what a real cartographic label engine does, and it
  // means the density stays sane at EVERY zoom rather than only the one tuned.
  const cand = [];
  for(let i=0;i<_placeData.length;i++){
    const p = _placeData[i];
    if(z < p.z) continue;
    // Test the place against every world copy, not just its true longitude.
    // Without this the repeated worlds either side come out unlabelled: the
    // viewport bounds out there run past ±180 and contains() rejects the
    // real coordinate. Only copies actually on screen produce a label, so
    // this costs nothing at the default view.
    for(let w=0;w<WORLD_COPIES.length;w++){
      const off = WORLD_COPIES[w];
      const wx  = p.x + off;
      if(!b.contains([p.y, wx])) continue;
      cand.push(off ? {y:p.y, x:wx, z:p.z, k:p.k, n:p.n, p:p.p} : p);
    }
  }
  cand.sort(function(a,c){ return (c.p||0) - (a.p||0); });

  const placed = [];                        // [x1,y1,x2,y2] in screen pixels
  const markers = [];
  const offsets = [];                       // filled per label below
  for(let i=0;i<cand.length;i++){
    const p = cand[i];
    const pt = map.latLngToContainerPoint([p.y, p.x]);
    // Approximate the label box. Character widths are close enough for a
    // spacing test and cost nothing compared with measuring real DOM.
    const cw   = (p.k === 'country') ? 8.2 : (p.k === 'state') ? 7.0 : 5.6;
    const w    = p.n.length * cw;
    const h    = 13;
    const cen  = (p.k !== 'city');          // countries/states centre on the point

    // A city name marks one exact point and cannot move. A country or state
    // name is a caption for a whole region and may sit anywhere sensible
    // inside it, so if its first choice is taken it tries a few positions
    // above and below before giving up. Without this, ranking cities first
    // meant "NORTH CAROLINA" was dropped whenever it landed on Charlotte --
    // the two sit at the same latitude a third of a degree apart.
    const tries = cen ? [0, -17, 17, -34, 34, -52, 52] : [0];

    let ox = null, oy = 0;
    for(let t=0;t<tries.length;t++){
      const dy = tries[t];
      const x1 = cen ? pt.x - w/2 : pt.x + 5;
      const y1 = pt.y + dy - h/2;
      const x2 = x1 + w, y2 = y1 + h;
      let hit = false;
      for(let j=0;j<placed.length;j++){
        const q = placed[j];
        if(x1 < q[2] && x2 > q[0] && y1 < q[3] && y2 > q[1]){ hit = true; break; }
      }
      if(!hit){ placed.push([x1, y1, x2, y2]); ox = x1; oy = dy; break; }
    }
    if(ox === null) continue;               // no room anywhere — leave it out
    offsets.push(oy);
    // Cities get a small tick; countries and states are text only.
    const sty  = oy ? ' style="margin-top:'+oy+'px"' : '';
    const html = (p.k === 'city')
      ? '<span class="pl-dot"></span><span class="pl-txt"'+sty+'>'+p.n+'</span>'
      : '<span class="pl-txt"'+sty+'>'+p.n+'</span>';
    markers.push(L.marker([p.y, p.x], {
      icon: L.divIcon({className:'pl '+_placeClass(p.k), html:html,
                       iconSize:null, iconAnchor:[0,0]}),
      interactive: false,                 // never steal a click from a station
      keyboard: false,
      // Keep place names UNDER every station marker. Done per-marker rather
      // than by restyling a pane: the marker pane is shared with the stations
      // and the overlay pane with the lines, so moving either would drag
      // things with it that must not move.
      zIndexOffset: -10000
    }));
  }
  if(_placeLayer) map.removeLayer(_placeLayer);
  _placeLayer = L.layerGroup(markers).addTo(map);
}

fetch('js8map_places.json' + _CACHE_TAG).then(r=>r.json()).then(d => {
  _placeData = d;
  _drawPlaces();
}).catch(()=>{});

map.on('zoomend moveend', _drawPlaces);

function togglePlaces(){
  _placesOn = !_placesOn;
  const b = $('places-btn');
  if(b) b.textContent = _placesOn ? '🌐 Hide Names' : '🌐 Show Names';
  SS.setItem('map_places', _placesOn ? '1' : '0');
  _drawPlaces();
}
(function _restorePlacesPref(){
  const saved = SS.getItem('map_places');
  if(saved !== null && saved !== undefined && saved !== '') {
    _placesOn = (saved === '1');
  }
  const b = $('places-btn');
  if(b) b.textContent = _placesOn ? '🌐 Hide Names' : '🌐 Show Names';
})();

// App-switch button (JS8Map -> JS8FastChat). POSTs to the local JS8Map
// server, which writes a small "raise my window" signal file that JS8FastChat
// polls for and acts on (brings its main console window to the front) within
// ~2 s. Relative URL -- no port needed this direction, the page is served by
// JS8Map itself. Fire-and-forget: success IS the other window appearing, so
// there's no status target to update; we just swallow errors quietly (same
// spirit as the /refresh calls). JS8FastChat must already be running.
function openFastChatWindow(){
  fetch('/raise_window_fastchat', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: '{}',
    signal: AbortSignal.timeout(3000)
  }).catch(function(){ /* JS8FastChat not running / server busy -- no-op */ });
}

/* ── Phase 10: FastChat presence — gray the ⚡ FastChat button when the
   FastChat app is not running ───────────────────────────────────────────
   JS8Map's server exposes /fastchat_alive, which reads the shared-folder
   sentinel FastChat writes while running. We poll it only while a callsign
   popup is open (started on popupopen, stopped on popupclose) and set every
   .js8map-fastchat-btn in the open popup to enabled or grayed to match.
   A disabled button can't be clicked, so a handoff is never sent into the
   void when FastChat isn't there to receive it.                          */
let _fcAliveTimer   = null;
let _fcAliveLastVal = null;   // cache so we only touch the DOM on change

function _applyFastChatButtonState(isAlive){
  const btns = document.querySelectorAll('.js8map-fastchat-btn');
  btns.forEach(function(btn){
    if(isAlive){
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = 'pointer';
      btn.style.filter = '';
      const call = btn.getAttribute('data-call') || '';
      btn.title = 'Open ' + call + ' in JS8FastChat';
    } else {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
      btn.style.filter = 'grayscale(1)';
      btn.title = 'JS8FastChat is not running — launch it to enable this';
    }
  });
}

async function _checkFastChatAlive(){
  let alive = false;
  try {
    const r = await fetch('/fastchat_alive', { signal: AbortSignal.timeout(2500) });
    if(r.ok){
      const j = await r.json();
      alive = !!(j && j.alive);
    }
  } catch(e){
    alive = false;   // server busy / not reachable -> treat as not running
  }
  if(alive !== _fcAliveLastVal){
    _fcAliveLastVal = alive;
    _applyFastChatButtonState(alive);
  }
}

function _startFastChatAlivePoll(){
  _fcAliveLastVal = null;      // force a fresh DOM apply on the next check
  _checkFastChatAlive();       // immediate check so there's no gray flash
  if(_fcAliveTimer) clearInterval(_fcAliveTimer);
  _fcAliveTimer = setInterval(_checkFastChatAlive, 3000);
}

function _stopFastChatAlivePoll(){
  if(_fcAliveTimer){ clearInterval(_fcAliveTimer); _fcAliveTimer = null; }
}

function toggleStyle(){
  const btn = $('map-style-btn');
  // TILES entries are null when no provider key is configured (the normal
  // offline case). Light/dark still switches the borders, labels, station
  // colours and page theme — only the optional tile backdrop is absent.
  if(currentStyle === 'dark'){
    if(TILES.dark)  map.removeLayer(TILES.dark);
    if(TILES.light) TILES.light.addTo(map);
    currentStyle = 'light';
    document.body.classList.add('light-theme');
    btn.textContent = '🌙 Dark Map';
  } else {
    if(TILES.light) map.removeLayer(TILES.light);
    if(TILES.dark)  TILES.dark.addTo(map);
    currentStyle = 'dark';
    document.body.classList.remove('light-theme');
    btn.textContent = '☀️ Light Map';
  }
  SS.setItem('map_theme', currentStyle);
  // Re-apply active filter style for new theme
  var activeStat = document.querySelector('.stat.active-filter');
  if(activeStat) _applyStatStyle(activeStat, activeStat.getAttribute('data-filter'), true);
  addBoundaries(currentStyle === 'dark');
  // Boost line weight + opacity in light mode so gold lines stay visible
  const _lm = currentStyle === 'light';
  LAYERS.forEach(function(lay){
    if(lay && lay.line){
      lay.line.setStyle({
        weight:  _lm ? 2.8 : 1.8,
        opacity: _lm ? 0.75 : 0.45
      });
    }
  });
}

/* ── Live data polling — B.11 ─────────────────────────────────────────────
   _pollData fires every 5s (cheap timestamp check).
   New stations appear immediately via _applyAdditions().
   Expired stations are only removed when the 5s scan-line sweep completes
   (every 60s), so departures feel deliberate rather than silent.
   Open popups are never disturbed during either pass.                     */

let _lastDataTs  = GENERATE_TS;
let _latestData  = null;   // always holds the most recent data.json payload

/* ── New-arrival pulse ring ──────────────────────────────────────────────
   Injects a SMIL-animated SVG circle directly into the station dot SVG.
   Consistent with HB/watched rings already in mkDot.
   Auto-removes from DOM after 30 seconds.                                */
function _addNewPulse(marker, call){
  // Add pulsing border to the callsign label box for 30s after first appearance.
  // Targets the tooltip element (the label div) — survives setTooltipContent()
  // calls since those only replace innerHTML, not the outer element.
  setTimeout(()=>{
    const tt = marker.getTooltip();
    if(!tt) return;
    const el = tt.getElement();
    if(!el) return;
    el.classList.add('station-label-new');
    setTimeout(()=>{ el.classList.remove('station-label-new'); }, 15000);
  }, 200);
}

/* ── Dynamic group color CSS injection ───────────────────────────────
   _build_group_css() bakes color rules into the HTML at render time.
   Stations that arrive via live data.json polling after page load may
   carry group colors not present at render time. This injects the
   matching CSS rule on first encounter so the label border appears.   */
function _ensureGroupColorCSS(color){
  if(!color) return;
  const cls = 'grp-' + color.replace('#','');
  const id  = 'dyn-' + cls;
  if(document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent =
    `.station-label-group.${cls} .label-box{` +
    `border-color:${color}!important;` +
    `border-width:1.5px!important;` +
    `box-shadow:0 3px 14px rgba(0,0,0,.88),0 0 5px ${color}55!important;}`;
  document.head.appendChild(s);
}

function _ensureGroupOption(name){
  // Adds a group name to the filter dropdown if not already present.
  // Needed because group options are baked into the HTML at render
  // time — groups that appear after page load (via data.json) must be
  // injected dynamically so the user can select them.
  if(!name) return;
  const sel = $('group-filter');
  if(!sel) return;
  if(Array.from(sel.options).some(o=>o.value===name)) return;
  const opt = document.createElement('option');
  opt.value       = name;
  opt.textContent = name;
  sel.appendChild(opt);
}

/* ── Additions pass — runs immediately when new data arrives ─────────── */
function _applyAdditions(data){
  const newStations   = data.stations    || [];
  const newRelayPaths = data.relay_paths || {};
  if(typeof data.tx_halt_enabled === 'boolean') _txHaltEnabledLive = data.tx_halt_enabled;

  // Sync group filter dropdown — options may be absent if page loaded before
  // groups were active. Safe to call every poll; _ensureGroupOption is a no-op
  // for options already present.
  (data.group_names || []).forEach(n => _ensureGroupOption(n));

  let heardN=0, hearingN=0, bothN=0, hbN=0, watchedN=0;
  const oob=[];  // [lat, lon, call] for new stations — passed to _fitForNewStations
  newStations.forEach(s=>{
    const col  = C[s.type]||'#888';
    const pos  = [s.lat, s.lon];
    const dist = haversine(MY_LAT, MY_LON, s.lat, s.lon);
    const mi   = Math.round(dist * 0.621371);

    if(s.type==='heard')           heardN++;
    else if(s.type==='hearing_me') hearingN++;
    else if(s.type==='both')       bothN++;
    if(s.via_hb) hbN++;
    if(s.watched) watchedN++;

    const existing = LAYER_MAP[s.call];
    if(!existing){
      // Brand-new callsign — add to map immediately
      // Line uses the antimeridian-aware endpoint so far-side DX draws the SHORT
      // way; the marker uses the same endpoint, so the box sits where the line ends.
      const line = L.polyline([[MY_LAT,MY_LON],_shortPathEnd(s.lat,s.lon)],{
        color:col,
        weight:  (typeof currentStyle !== 'undefined' && currentStyle === 'light') ? 2.8 : 1.8,
        opacity: (typeof currentStyle !== 'undefined' && currentStyle === 'light') ? 0.75 : 0.45,
        dashArray: s.type==='hearing_me'?'6 5':null,
        interactive: false
      }).addTo(map);
      const marker = L.marker(_shortPathEnd(s.lat,s.lon),{
        icon:mkDot(col,18,s.via_hb,s.heard_by?s.heard_by.length:0,
                   s.approx,s.has_inbox,s.watched,
                   s.station_hears?s.station_hears.length:0)
      })
        .addTo(map)
        .bindTooltip(mkLabel(s),{
          permanent:true, direction:'right', offset:[10,0],
          className:'station-label'+(s.watched?' station-label-watched':'')+
                    (s.group_color?' station-label-group grp-'+s.group_color.replace('#',''):''),
          opacity:1
        })
        .bindPopup(mkPopup(s,col,dist,mi),{
          maxWidth:360, autoPan:true,
          autoPanPaddingTopLeft:L.point(20,90),
          autoPanPaddingBottomRight:L.point(20,30)
        });

      const _entry={type:s.type, call:s.call, station:s, marker, line};
      LAYERS.push(_entry);
      LAYER_MAP[s.call]=_entry;
      _ensureGroupColorCSS(s.group_color);    // inject CSS if color not yet in page
      _addNewPulse(marker, s.call);           // 30s white pulse on label box
      oob.push([s.lat, s.lon, s.call]);   // candidate for expand-fit
    } else {
      // Existing station — update in place, leave open popups alone
      existing.type    = s.type;
      existing.station = s;
      _ensureGroupColorCSS(s.group_color);  // color may have changed since last update
      existing.marker.setIcon(
        mkDot(col,18,s.via_hb,s.heard_by?s.heard_by.length:0,
              s.approx,s.has_inbox,s.watched,
              s.station_hears?s.station_hears.length:0)
      );
      existing.line.setStyle({
        color:col,
        dashArray: s.type==='hearing_me'?'6 5':null
      });
      existing.marker.setTooltipContent(mkLabel(s));
      if(!existing.marker.isPopupOpen()){
        existing.marker.setPopupContent(mkPopup(s,col,dist,mi));
      }
    }
  });

  // Merge updated relay paths into RELAY_BY_VIA
  for(const [tgt, arr] of Object.entries(newRelayPaths)){
    for(const p of arr){
      if(!RELAY_BY_VIA[p.via]) RELAY_BY_VIA[p.via]=[];
      const idx=RELAY_BY_VIA[p.via].findIndex(x=>x.target===tgt);
      const rEntry={target:tgt,snr:p.snr,snr_to_me:p.snr_to_me,
                    composite:p.composite,age_min:p.age_min,confidence:p.confidence};
      if(idx>=0) RELAY_BY_VIA[p.via][idx]=rEntry;
      else RELAY_BY_VIA[p.via].push(rEntry);
    }
  }

  // Update counters (additions only — total reflects current LAYERS size)
  $('cnt-heard').textContent   = heardN;
  $('cnt-hearing').textContent = hearingN;
  $('cnt-both').textContent    = bothN;
  $('cnt-total').textContent   = newStations.length;
  if($('cnt-hb'))      $('cnt-hb').textContent      = hbN;
  if($('cnt-watched')) $('cnt-watched').textContent = watchedN;

  applyFilters();
  _fitForNewStations(oob);  // expand viewport for any new arrivals outside current bounds

  // Initial auto-fit: the FIRST time markers actually populate after a Generate
  // Map, frame them once so a new user sees their stations nicely zoomed --
  // instead of tiny dots on a zoomed-out world map that looks broken. This is
  // event-driven (fires the moment markers exist), not a blind timer, so it
  // works whether stations were present at page load or streamed in over the
  // next few seconds. Guards:
  //   * once per generated map (GENERATE_TS session key)
  //   * only if the user hasn't panned/zoomed yet (_userHasMoved)
  //   * only when there is actually something to frame (LAYERS non-empty)
  // It never fires on later refreshes, so it can't fight manual navigation.
  if(!_userHasMoved && LAYERS.length > 0){
    const _initFitKey = 'fitted_' + GENERATE_TS;
    if(!sessionStorage.getItem(_initFitKey)){
      sessionStorage.setItem(_initFitKey, '1');
      // small delay lets Leaflet finish adding the marker layer before we
      // compute bounds, so the fit is accurate on the very first paint
      setTimeout(function(){ if(!_userHasMoved) fitAll(); }, 200);
    }
  }

  // B.15: auto-populate relay filter when Python Arm is pressed
  const at = data.armed_target || null;
  if(at && at !== _lastArmedTarget){
    _lastArmedTarget  = at;
    _chainTargetPos   = data.armed_target_pos || null;
    _chainTarget      = at;
    // Populate relay search box and fire filter
    const rs = $('relay-search');
    if(rs) rs.value = at;
    const rc = $('relay-clear');
    if(rc) rc.style.display = 'block';
    applyRelayFilter(at);
  }

  // C.16: restore relay_committed across page refreshes
  // data.json is rebuilt every cycle — if relay_committed is set in Python,
  // re-apply it so _handleRelayAnim survives the JS state wipe.
  const rcom = data.relay_committed;
  if(rcom && rcom.via && rcom.target && !_chainCommitted
     && _chainTarget === rcom.target){
    _chainVia        = rcom.via;
    _chainCommitted  = true;
    _relayAnimState  = null;   // force re-trigger on next poll after legs restored
    if(!_chainLegs.length) _drawChainLegs();
    applyRelayFilter(_chainTarget);
  }
  // 17d: legs were waiting for the via's dot -- draw them now it is here,
  // and replay the current animation step on the new legs.
  if(_chainLegsWaitVia && _chainVia && LAYER_MAP[_chainVia]){
    _clearChainLegs();
    _drawChainLegs();
    if(_chainLegs.length) _relayAnimState = null;
  }
}

/* ── Removals pass — runs after scan-line sweep completes ────────────── */
function _applyRemovals(){
  if(!_latestData) return;
  const newByCall = {};
  (_latestData.stations || []).forEach(s=>{ newByCall[s.call]=s; });

  let removed = false;
  for(let i = LAYERS.length - 1; i >= 0; i--){
    const l = LAYERS[i];
    if(!newByCall[l.call]){
      map.removeLayer(l.marker);
      map.removeLayer(l.line);
      delete LAYER_MAP[l.call];
      LAYERS.splice(i, 1);
      removed = true;
    }
  }

  if(removed){
    // Recount from live LAYERS
    let heardN=0, hearingN=0, bothN=0, hbN=0;
    LAYERS.forEach(l=>{
      if(l.type==='heard')           heardN++;
      else if(l.type==='hearing_me') hearingN++;
      else if(l.type==='both')       bothN++;
      if(l.station && l.station.via_hb) hbN++;
    });
    $('cnt-heard').textContent   = heardN;
    $('cnt-hearing').textContent = hearingN;
    $('cnt-both').textContent    = bothN;
    $('cnt-total').textContent   = LAYERS.length;
    if($('cnt-hb')) $('cnt-hb').textContent = hbN;
    applyFilters();
  }
}

/* ── Scan-line sweep — triggers removals on completion ──────────────── */
function _runScanLine(){
  const overlay = $('scan-overlay');
  const lineEl  = $('scan-line');
  const done    = $('scan-done');

  // Before the sweep starts, identify callsigns that will be removed and
  // give them a blue pulsing glow so the user sees the warning coming.
  if(_latestData){
    const newByCall={};
    (_latestData.stations||[]).forEach(s=>{ newByCall[s.call]=s; });
    LAYERS.forEach(l=>{
      if(!newByCall[l.call]){
        const tt=l.marker.getTooltip();
        if(tt){ const el=tt.getElement(); if(el) el.classList.add('station-label-expiring'); }
      }
    });
  }

  if(!overlay || !lineEl) { _applyRemovals(); return; }
  overlay.style.display = 'block';
  const nl = lineEl.cloneNode(true);
  overlay.replaceChild(nl, lineEl);

  // After the 5s sweep: cull expired stations, clean up any survivors that
  // had the expiring class but were refreshed during the sweep, show toast.
  setTimeout(()=>{
    overlay.style.display = 'none';
    _applyRemovals();
    // Remove expiring class from stations that survived (still in LAYERS)
    LAYERS.forEach(l=>{
      const tt=l.marker.getTooltip();
      if(tt){ const el=tt.getElement(); if(el) el.classList.remove('station-label-expiring'); }
    });
    if(done){
      done.style.display   = 'block';
      done.style.animation = 'none';
      done.offsetHeight;
      done.style.animation = 'scan-fade 1.8s ease-out forwards';
      setTimeout(()=>{ done.style.display='none'; }, 1800);
    }
  }, 5000);
}

function _pollData(){
  fetch('/data.json?_='+Date.now())
    .then(r=>r.json())
    .then(data=>{
      if(data.ts && data.ts !== _lastDataTs){
        _lastDataTs  = data.ts;
        const prevCount = LAYERS.length;
        _latestData  = data;
        _applyAdditions(data);
        // Bug #6 fix: _applyAdditions only ADDS markers; it never removes ones
        // whose callsign vanished from the data. After a Clear (QSY) in JS8Map
        // (which empties the spot DB) the old markers used to linger -- counters
        // showed 0 but the markers stayed -- until the 60s scan-line sweep. We
        // now detect a BULK drop (a clear/QSY: the new data has far fewer, or
        // zero, stations than we currently show) and reconcile removals right
        // away. Normal single-station aging is left to the 60s sweep so its
        // "expiring" warning glow still plays; only a big clear jumps the queue.
        const newCount = (data.stations || []).length;
        const bulkClear = (prevCount > 0) && (newCount === 0 || newCount <= prevCount - 3);
        if(bulkClear){
          _applyRemovals();
        }
      }
    })
    .catch(()=>{});
}

/* ── Timers ── */
setInterval(_pollData,    5000);   // fast poll — cheap ts check, additions immediate
setInterval(_runScanLine, 60000);  // 60s sweep — culls expired callsigns on completion

// Restore New filter after page reload — browser preserves the dropdown
// visual value but JS state resets to 0.  Re-apply so the filter works.
(function(){
  const sel = $('new-filter-select');
  if(sel){
    const v = parseInt(sel.value);
    if(v > 0) setNewFilter(v);
  }
})();

// Restore Active filter after page reload (same reasoning as New filter above).
(function(){
  const sel = $('active-filter-select');
  if(sel){
    const v = parseInt(sel.value);
    if(v > 0) setActiveFilter(v);
  }
})();

/* ── Utilities ── */
function haversine(la1,lo1,la2,lo2){
  const R=6371,d=Math.PI/180;
  const a=Math.sin((la2-la1)*d/2)**2+
    Math.cos(la1*d)*Math.cos(la2*d)*Math.sin((lo2-lo1)*d/2)**2;
  return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
}
function fmtFreq(hz){
  if(!hz||hz===0) return '—';
  return (hz/1e6).toFixed(3)+' MHz';
}
function fmtSpeed(v){
  const modes = {0:'Normal',1:'Fast',2:'Turbo',3:'Slow',4:'Ultra'};
  return modes[v] !== undefined ? modes[v] : '—';
}
// Parse a JS8Map DB timestamp ("YYYY-MM-DD HH:MM:SS", optionally suffixed
// " UTC") as a UTC epoch in ms. JS8Map writes these stamps in UTC; building a
// Date from the bare components reads them as LOCAL and throws the age off by
// the operator's UTC offset (negative on US stations), so we use Date.UTC().
// The trailing " UTC" token is harmless -- it splits off as an extra element
// we never read. Returns NaN for anything unparseable.
function tsToMsUTC(ts){
  if(!ts) return NaN;
  const p = String(ts).replace('T',' ').replace(/-/g,' ').replace(/:/g,' ').split(' ');
  if(p.length < 3) return NaN;
  return Date.UTC(+p[0], +p[1]-1, +p[2], +(p[3]||0), +(p[4]||0), +(p[5]||0));
}
function fmtAge(ts){
  if(!ts || ts.length < 10) return '—';
  const ms = tsToMsUTC(ts);
  if(isNaN(ms)) return '—';
  let sec = Math.round((Date.now() - ms) / 1000);
  if(sec < 0) sec = 0;                 // tiny clock skew -> treat as "now"
  if(sec < 60)    return sec + 's ago';
  if(sec < 3600)  return Math.floor(sec/60) + 'm ago';
  if(sec < 86400) return Math.floor(sec/3600) + 'h ago';
  return Math.floor(sec/86400) + 'd ago';
}
function snrColor(snr){
  if(snr>=0)   return '#26a869';
  if(snr>=-10) return '#f5a623';
  return '#e84060';
}
function mkDot(color, size, isHB, hearingCount, isApprox, hasInbox, isWatched, hearsCount){
  const R  = size / 2;
  const cx = R + 6;
  const cy = R + 6;
  const w  = size + 12;

  // ── Main dot ────────────────────────────────────────────────────
  const dot = isApprox
    ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${color}" opacity="0.8"
         stroke="rgba(0,0,0,0.4)" stroke-width="1.5"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${color}"
         stroke="rgba(0,0,0,0.4)" stroke-width="1.5"/>`;

  // ── HB sonar rings ──────────────────────────────────────────────
  // Start inside dot (r=R*0.4), only visible after clearing dot edge.
  // Max size kept small (R*2.2) so rings don't dominate the map.
  const hb = isHB ? `
    <circle cx="${cx}" cy="${cy}" r="${R*0.4}" fill="none"
        stroke="gold" stroke-width="1.5" opacity="0">
      <animate attributeName="r"
        values="${R*0.4};${R*2.2}" dur="2.6s" repeatCount="indefinite"/>
      <animate attributeName="opacity"
        values="0;0;0.55;0.1;0" keyTimes="0;0.18;0.28;0.85;1"
        dur="2.6s" repeatCount="indefinite"/>
    </circle>
    <circle cx="${cx}" cy="${cy}" r="${R*0.4}" fill="none"
        stroke="gold" stroke-width="1" opacity="0">
      <animate attributeName="r"
        values="${R*0.4};${R*2.2}" dur="2.6s" begin="1.3s" repeatCount="indefinite"/>
      <animate attributeName="opacity"
        values="0;0;0.35;0.05;0" keyTimes="0;0.18;0.28;0.85;1"
        dur="2.6s" begin="1.3s" repeatCount="indefinite"/>
    </circle>` : '';

  // ── Watched — silver breathing ring just outside dot ───────────────
  const watched = isWatched ? `
    <circle cx="${cx}" cy="${cy}" r="${R+3}" fill="none"
        stroke="#e0e0ff" stroke-width="2">
      <animate attributeName="r"
        values="${R+2};${R+5};${R+2}" dur="1.8s" repeatCount="indefinite"/>
      <animate attributeName="opacity"
        values="0.9;0.3;0.9" dur="1.8s" repeatCount="indefinite"/>
    </circle>` : '';

  // ── Inbox — small expanding ring just outside dot ─────────────────
  const inbox = hasInbox ? `
    <circle cx="${cx}" cy="${cy}" r="${R+1}" fill="none"
        stroke="gold" stroke-width="2" opacity="0">
      <animate attributeName="r"
        values="${R+1};${R+7}" dur="1.4s" repeatCount="indefinite"/>
      <animate attributeName="opacity"
        values="0.9;0" dur="1.4s" repeatCount="indefinite"/>
    </circle>` : '';

  // badge, hearsBadge, envelope removed — now handled by mkLabel slot row

  return L.divIcon({
    html:`<svg width="${w}" height="${w}" xmlns="http://www.w3.org/2000/svg"
            style="overflow:visible;display:block;">
      ${hb}${watched}${inbox}${dot}
    </svg>`,
    iconSize:   [w, w],
    iconAnchor: [cx, cy],
    className:  ''
  });
}

function mkLabel(s){
  // Show SNR for any non-null value including 0 dB (genuine signal reading)
  const hasSnr = (s.snr !== undefined && s.snr !== null);
  const sc     = snrColor(s.snr);
  const snrStr = hasSnr ? (s.snr>0?'+':'')+Math.round(s.snr)+'dB' : '';
  const opacity = 1.0;

  // ── 4 fixed notification slots above the callsign box ──────────────────
  // Slot 1: heard-by count (green)   — how many stations hear this station
  // Slot 2: hears count (teal)       — how many stations this station hears
  // Slot 3: inbox/MSG (gold)         — message waiting in inbox
  // Slot 4: reserved                 — empty placeholder
  const heardN  = s.heard_by      ? Math.min(s.heard_by.length, 9)      : 0;
  const hearsN  = s.station_hears ? Math.min(s.station_hears.length, 9) : 0;

  const s1 = heardN > 0
    ? '<div class="notif-slot" style="background:#26a869;color:#fff;border-radius:50%;">' + heardN + '</div>'
    : '<div class="notif-slot"></div>';

  const s2 = hearsN > 0
    ? '<div class="notif-slot" style="background:#0097a7;color:#fff;border-radius:50%;">' + hearsN + '</div>'
    : '<div class="notif-slot"></div>';

  const s3 = s.has_inbox
    ? '<div class="notif-slot" style="color:#FFD700;font-size:13px;">✉</div>'
    : '<div class="notif-slot"></div>';

  const s4 = '<div class="notif-slot"></div>';

  // Only render slot row when at least one slot is populated
  const anySlot = heardN > 0 || hearsN > 0 || s.has_inbox;
  const slots = anySlot
    ? '<div class="notif-slots">' + s1 + s2 + s3 + s4 + '</div>'
    : '';

  const labelText = '<span style="opacity:' + opacity + ';">'
    + (snrStr
      ? '<span style="font-weight:600;color:' + sc + ';letter-spacing:-0.3px;">' + snrStr + '</span><span style="color:rgba(255,255,255,0.4);"> </span>'
      : '')
    + '<span style="font-weight:500;color:#ffffff;letter-spacing:-0.2px;">' + s.call + '</span>'
    + '</span>';

  return '<div style="display:inline-flex;flex-direction:column;align-items:center;pointer-events:none;">'
    + slots
    + '<span class="label-box" data-call="' + s.call + '">' + labelText + '</span>'
    + '</div>';
}

let showLabels = savedLabels;
let popupDefault = savedPopup;  // 'full' or 'compact'

function setPopupDefault(val){
  popupDefault = val;
  SS.setItem('map_popup', val);
}
function toggleAnim(){
  _animEnabled = !_animEnabled;
  const btn = $('anim-btn');
  if(btn) btn.textContent = _animEnabled ? '\uD83C\uDFAC Anim On' : '\uD83C\uDFAC Anim Off';
  SS.setItem('map_anim', String(_animEnabled));
  if(!_animEnabled){ _stopCometAnims(); _relayAnimState = null; }
}
function toggleLabels(){
  showLabels = !showLabels;
  $('label-btn').textContent = showLabels ? '🏷 Hide Labels' : '🏷 Show Labels';
  map.getContainer().classList.toggle('hide-labels', !showLabels);
  SS.setItem('map_labels', showLabels);
}
if(!showLabels){
  map.getContainer().classList.add('hide-labels');
  $('label-btn').textContent = '🏷 Show Labels';
}

/* ── Popup builder ── */
const BADGE_COLOR = {
  heard:      'background:'+COLORS.heard.bg+';color:'+COLORS.heard.primary+';',
  hearing_me: 'background:'+COLORS.hearing_me.bg+';color:'+COLORS.hearing_me.primary+';',
  both:       'background:'+COLORS.both.bg+';color:'+COLORS.both.primary+';'
};
const BADGE_ICON  = {heard:'👂', hearing_me:'📡', both:'🔄'};
const BADGE_LABEL = {heard:'I Hear', hearing_me:'Hears Me', both:'Mutual'};

function mkPopup(s, col, dist, mi){
  const snrStr = (s.snr !== null && s.snr !== undefined) ? (s.snr>0?'+':'')+Math.round(s.snr)+' dB' : '—';
  const sc     = snrColor(s.snr);
  const fccName = s.fcc_name
    ? `<div class="p-fcc-name">${s.fcc_name}</div>` : '';
  const fccLoc = (s.fcc_city||s.fcc_state||s.fcc_class)
    ? `<div class="p-fcc-loc">${[s.fcc_city,s.fcc_state].filter(Boolean).join(', ')}${s.fcc_class?' &nbsp;·&nbsp; <b>'+s.fcc_class+'</b>':''}</div>`
    : '';
  const approxNote = s.approx
    ? `<div style="font-size:10px;color:var(--text);background:rgba(245,166,35,0.12);
        border:1px solid rgba(245,166,35,0.45);border-radius:5px;
        padding:4px 7px;margin:4px 0 2px;line-height:1.4;">
        <span style="color:var(--orange,#f5a623);">⚠</span> FCC approximate location.
       </div>`
    : '';

  let heardByHtml = '';
  if(s.heard_by && s.heard_by.length > 0){
    const rows = s.heard_by.map(e=>{
      const snrTxt = (e.snr !== null && e.snr !== undefined && e.snr !== 0)
        ? `<span style="color:${snrColor(e.snr)};font-weight:700;">${e.snr>0?'+':''}${Math.round(e.snr)}dB</span>`
        : '';
      return `<tr>
        <td style="font-family:var(--font-main);font-size:12px;font-weight:600;color:var(--text);padding:3px 8px 3px 0;">${e.by}</td>
        <td style="text-align:center;padding:3px 4px;">${snrTxt}</td>
        <td style="text-align:right;padding:3px 0;font-size:12px;font-weight:600;color:var(--text);">${e.ts.substring(11)}</td>
      </tr>`;
    }).join('');
    heardByHtml = `
    <div class="p-divider"></div>
    <div class="p-section-hdr">👂 Heard By (last 30 min)</div>
    <table class="p-sub-table">${rows}</table>`;
  }

  let stationHearsHtml = '';
  if(s.station_hears && s.station_hears.length > 0){
    const rows = s.station_hears.map(e=>{
      const snrTxt = (e.snr !== null && e.snr !== undefined && e.snr !== 0)
        ? `<span style="color:${snrColor(e.snr)};font-weight:700;">${e.snr>0?'+':''}${Math.round(e.snr)}dB</span>`
        : '';
      return `<tr>
        <td style="font-family:var(--font-main);font-size:12px;font-weight:600;color:var(--text);padding:3px 8px 3px 0;">${e.call}</td>
        <td style="text-align:center;padding:3px 4px;">${snrTxt}</td>
        <td style="text-align:right;padding:3px 0;font-size:12px;font-weight:600;color:var(--text);">${e.ts.substring(11)}</td>
      </tr>`;
    }).join('');
    stationHearsHtml = `
    <div class="p-divider"></div>
    <div class="p-section-hdr">📻 They Are Hearing (last 30 min)</div>
    <table class="p-sub-table">${rows}</table>`;
  }

  const canMsg = (s.type === 'both' || s.type === 'hearing_me');
  const canSnr = (s.type === 'heard');   // I hear them — try SNR? to establish mutual
  const msgBtn = canMsg ? `
    <div class="p-divider"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;">
      <button onclick="sendJS8(event,'${s.call}','SNR')"
        style="flex:1;font-family:var(--font-main);font-size:11px;font-weight:700;
          background:#0d3a5c;color:#29b6f6;border:1px solid #29b6f6;
          border-radius:5px;padding:5px 8px;cursor:pointer;"
        title="What is my SNR? — asks ${s.call}">📶 SNR?</button>
      <button onclick="sendJS8(event,'${s.call}','HEARING')"
        style="flex:1;font-family:var(--font-main);font-size:11px;font-weight:700;
          background:#0d3d22;color:#26a869;border:1px solid #26a869;
          border-radius:5px;padding:5px 8px;cursor:pointer;"
        title="What stations are you HEARING? — asks ${s.call}">👂 HEARING?</button>
      <button onclick="sendJS8(event,'${s.call}','MSG')"
        style="flex:1;font-family:var(--font-main);font-size:11px;font-weight:700;
          background:#1a1a3a;color:#d0dce8;border:1px solid #4a6680;
          border-radius:5px;padding:5px 8px;cursor:pointer;"
        title="Send a message to ${s.call}'s inbox">✉ MSG</button>
      <button onclick="openInFastChat(event,'${s.call}')"
        class="js8map-fastchat-btn" data-call="${s.call}"
        style="flex:1;font-family:var(--font-main);font-size:11px;font-weight:700;
          background:#3d3000;color:#FFD700;border:1px solid #FFD700;
          border-radius:5px;padding:5px 8px;cursor:pointer;"
        title="Open FastChat popup screen for ${s.call}">⚡ FastChat</button>
    </div>
    <div id="js8-status-${s.call.replace('/','_')}"
      style="font-size:12px;margin-top:4px;min-height:18px;border-radius:5px;transition:all .2s;"></div>
  ` : canSnr ? `
    <div class="p-divider"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;">
      <button onclick="sendJS8(event,'${s.call}','SNR')"
        style="flex:1;font-family:var(--font-main);font-size:11px;font-weight:700;
          background:#0d3a5c;color:#29b6f6;border:1px solid #29b6f6;
          border-radius:5px;padding:5px 8px;cursor:pointer;"
        title="Send SNR? — if they reply you'll become Mutual">📶 SNR?</button>
      <button onclick="openInFastChat(event,'${s.call}')"
        class="js8map-fastchat-btn" data-call="${s.call}"
        style="flex:1;font-family:var(--font-main);font-size:11px;font-weight:700;
          background:#3d3000;color:#FFD700;border:1px solid #FFD700;
          border-radius:5px;padding:5px 8px;cursor:pointer;"
        title="Open FastChat popup screen for ${s.call}">⚡ FastChat</button>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:4px;font-style:italic;">
      Send SNR? to check for mutual hearing
    </div>
    <div id="js8-status-${s.call.replace('/','_')}"
      style="font-size:12px;margin-top:4px;min-height:18px;border-radius:5px;transition:all .2s;"></div>
  ` : '';

  const uid = 'p-' + s.call.replace(/[^A-Z0-9]/g,'_');
  const proofAge = s.snr_proof_ts
    ? (Date.now() - tsToMsUTC(s.snr_proof_ts)) / 3600000
    : 0;
  const proofColor = proofAge > 1 ? '#e05555' : null;  // red if >1h old
  const proofNote  = proofAge > 1 ? ` <span style="font-size:10px;opacity:.8;">(${Math.round(proofAge)}h ago)</span>` : '';
  const theyHearRow = (s.snr_of_me !== null && s.snr_of_me !== undefined)
    ? `<tr><td>They Hear Me</td><td style="color:${proofColor||snrColor(s.snr_of_me)};font-weight:700;">${s.snr_of_me>0?'+':''}${Math.round(s.snr_of_me)} dB${proofNote}</td></tr>`
    : '';

  // Always render in full — compact/full applied dynamically on popupopen
  // so dropdown changes take effect immediately without regenerating the map.
  return `<div class="p-inner" id="${uid}">

    <!-- ── Header: toggle LEFT, callsign right of it ── -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <button onclick="(function(btnEl){
          var el=btnEl.closest('.p-inner');
          if(!el) return;
          var full=el.querySelector('.p-full');
          var btn=el.querySelector('.p-toggle-btn');
          var compact=el.querySelector('.p-compact-extra');
          if(!full||!compact||!btn) return;
          var isCompact=(full.style.display==='none');
          full.style.display=isCompact?'':'none';
          compact.style.display=isCompact?'none':'';
          btn.textContent=isCompact?'⊟ Compact':'⊞ Full';
        })(this)"
        class="p-toggle-btn"
        title="Toggle between the compact and full popup view"
        style="font-size:12px;font-weight:800;padding:4px 10px;border-radius:10px;
          cursor:pointer;border:1.5px solid var(--blue);
          background:rgba(41,121,255,0.12);color:var(--blue);
          white-space:nowrap;flex-shrink:0;font-family:var(--font-main);
          letter-spacing:.3px;transition:background .15s;">
        ⊟ Compact
      </button>
      <div class="p-call" style="color:${col};margin-bottom:0;">${s.call}</div>
      <button onclick="toggleFitExclusion('${s.call}', this)"
        data-excluded="${FIT_EXCLUSIONS.has(s.call)}"
        title="${FIT_EXCLUSIONS.has(s.call) ? 'Click to include this station in the Fit All view again' : 'Remove this station from the Fit All view'}"
        style="font-size:12px;font-weight:800;padding:4px 16px;border-radius:10px;
          cursor:pointer;border:1.5px solid ${FIT_EXCLUSIONS.has(s.call) ? '#e84060' : 'rgba(255,255,255,0.7)'};
          background:rgba(0,0,0,0);color:${FIT_EXCLUSIONS.has(s.call) ? '#e84060' : 'rgba(255,255,255,0.7)'};
          white-space:nowrap;flex-shrink:0;font-family:var(--font-main);
          letter-spacing:.3px;margin-left:auto;margin-right:22px;">
        📐 Fit
      </button>
    </div>

    <!-- ── Badges ── -->
    <span class="p-badge" style="${
      s.has_pending_msg && s.type === 'both'
        ? 'background:#5a1010;color:#ff6b6b;'
        : (BADGE_COLOR[s.type]||'')
    }">
      ${BADGE_ICON[s.type]||''} ${BADGE_LABEL[s.type]||s.type}${s.has_pending_msg ? ' 📨' : ''}
    </span>
    ${s.via_hb ? '<span class="p-badge" style="background:#3a3000;color:gold;margin-left:5px;">📡 Heartbeat</span>' : ''}
    ${s.watched ? '<span class="p-badge" style="background:#3a2a00;color:#FFE000;margin-left:5px;">⭐ Watched</span>' : ''}
    ${s.has_inbox ? '<div style="background:#7a5a00;color:#FFD700;font-size:11px;font-weight:800;padding:5px 10px;border-radius:6px;margin-bottom:8px;letter-spacing:.5px;">✉ MESSAGE WAITING IN YOUR INBOX</div>' : ''}
    ${s.has_pending_msg ? '<div style="background:#5a1010;color:#ff6b6b;font-size:11px;font-weight:800;padding:5px 10px;border-radius:6px;margin-bottom:8px;letter-spacing:.5px;">📨 MESSAGE PENDING — PICK UP WHEN IN RANGE</div>' : ''}

    <!-- ── Compact view — shown/hidden by popupopen event ── -->
    <div class="p-compact-extra" style="display:none;">
      ${fccName}${fccLoc}
      <div class="p-divider"></div>
      <table class="p-table">
        <tr><td>I Hear Them</td><td style="color:${sc};font-weight:700;">${snrStr}</td></tr>
        ${theyHearRow}
        <tr><td>Distance</td><td>${dist.toLocaleString()} km / ${mi.toLocaleString()} mi</td></tr>
      </table>
    </div>

    <!-- ── Full view — shown/hidden by popupopen event ── -->
    <div class="p-full" style="display:block;">
      ${fccName}${fccLoc}${approxNote}
      <div class="p-divider"></div>
      <table class="p-table">
        <tr><td>Grid</td><td>
          ${s.grid}
          <button onclick="(function(e){e.stopPropagation();navigator.clipboard.writeText('${s.grid}').then(()=>{var b=e.target;var t=b.textContent;b.textContent='✓';setTimeout(()=>b.textContent=t,1200);}).catch(()=>{})})(event)"
            style="margin-left:6px;font-size:10px;font-weight:600;
              background:rgba(255,255,255,0.07);color:var(--muted);
              border:1px solid rgba(255,255,255,0.15);border-radius:4px;
              padding:1px 5px;cursor:pointer;vertical-align:middle;"
            title="Copy grid to clipboard">📋</button>
        </td></tr>
        <tr><td>I Hear Them</td><td style="color:${sc};font-weight:700;">${snrStr}</td></tr>
        ${theyHearRow}
        <tr><td>Distance</td><td>${dist.toLocaleString()} km / ${mi.toLocaleString()} mi</td></tr>
        <tr><td>Freq</td><td>${fmtFreq(s.freq)}</td></tr>
        <tr><td>Offset</td><td>${s.offset ? Math.round(s.offset)+' Hz' : '—'}</td></tr>
        <tr><td>Speed</td><td>${s.speed !== null && s.speed !== undefined ? fmtSpeed(s.speed) : '—'}</td></tr>
        <tr><td>Last Seen</td><td>${fmtAge(s.last_seen)}</td></tr>
      </table>
      ${heardByHtml}
      ${stationHearsHtml}

      <!-- ── Relay Paths (Can Relay To) ── -->
      ${(()=>{
        const viaPaths = (RELAY_BY_VIA[s.call] || []).slice(0,6);
        if(!viaPaths.length) return '';
        const rows = viaPaths.map(r=>{
          const l1 = r.snr_to_me!=null
            ? `<span style="color:${snrColor(r.snr_to_me)};font-weight:700;">${r.snr_to_me>0?'+':''}${Math.round(r.snr_to_me)}dB</span>`
            : '<span style="color:var(--muted);font-size:10px;">?</span>';
          const l2 = r.snr!=null
            ? `<span style="color:${snrColor(r.snr)};font-weight:700;">${r.snr>0?'+':''}${Math.round(r.snr)}dB</span>`
            : '<span style="color:var(--muted);font-size:10px;">?</span>';
          const cColor = r.confidence==='HIGH'?'#26a869':r.confidence==='MED'?'#ffb347':'#ff6b6b';
          const age = r.age_min<2?'now':`${r.age_min}m`;
          const copyCmd = `${s.call}>${r.target} `;
          return `<tr>
            <td style="font-family:var(--font-main);font-size:12px;font-weight:700;
              color:var(--text);padding:3px 6px 3px 0;">${r.target}</td>
            <td style="text-align:center;padding:3px 2px;" title="You→${s.call}">${l1}</td>
            <td style="text-align:center;padding:3px 2px;color:var(--muted);">→</td>
            <td style="text-align:center;padding:3px 2px;" title="${s.call}→${r.target}">${l2}</td>
            <td style="font-size:10px;font-weight:700;color:${cColor};padding:3px 4px;">${r.confidence}</td>
            <td style="text-align:right;font-size:10px;color:var(--muted);padding:3px 0;">${age}</td>
            <td style="padding:3px 0 3px 6px;">
              <button onclick="(function(b){navigator.clipboard.writeText('${copyCmd}')
                .then(()=>{b.textContent='✓';b.style.color='#26a869';
                  setTimeout(()=>{b.textContent='📋';b.style.color='';},1500);})
                .catch(()=>{})})(this)"
                style="font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;
                  cursor:pointer;background:rgba(41,121,255,0.12);color:var(--blue);
                  border:1px solid var(--blue);" title="Copy: ${copyCmd}">📋</button>
            </td>
          </tr>`;
        }).join('');
        return `
          <div class="p-divider"></div>
          <div class="p-section-hdr">🔁 Can Relay To (${viaPaths.length}) — You→Relay→Target</div>
          <table class="p-sub-table">${rows}</table>
          <div style="font-size:10px;color:var(--muted);margin-top:3px;font-style:italic;">
            Click a relay button below to compose &amp; send the message here
          </div>`;
      })()}

      <!-- ── Relay button when filter active — opens the compose popup ── -->
      ${(()=>{
        if(!_relayTarget) return '';
        const rp = _mergeRelay(_relayTarget);
        const re = rp.find(r=>r.via===s.call);
        if(!re) return '';
        const rank = rp.indexOf(re)+1;
        return `
          <div class="p-divider"></div>
          <div style="text-align:center;padding:6px 0 4px;">
            <div style="font-size:10px;color:var(--muted);margin-bottom:5px;">
              Relay filter: <b style="color:#29b6f6;">${_relayTarget}</b> &nbsp;·&nbsp; Rank #${rank}
            </div>
            <button onclick="_relayFromPopup('${s.call}')"
              style="font-weight:800;font-size:13px;padding:8px 0;border-radius:8px;
                cursor:pointer;background:#29b6f6;color:#000;border:none;
                width:92%;display:block;margin:0 auto;">
              🔁 Relay to ${_relayTarget}
            </button>
            <div style="font-size:10px;color:var(--muted);margin-top:4px;">
              Type &amp; send the message here — no need to switch to JS8Call
            </div>
          </div>`;
      })()}

      <div class="qso-box" data-call="${s.call}"></div>
      ${msgBtn}
    </div>

  </div>`;
}

/* ── Save map position before popup opens, restore when closed ──────
   autoPan is enabled so popups near edges pan into view (no clipping).
   But we save the pre-pan center+zoom and fly back when popup closes,
   so the map always returns to exactly where the user left it.
   The Find callsign handler has its own save/restore and sets
   _popupFromFind=true to suppress this generic restore for that case. */
let _savedPopupCenter = null;
let _savedPopupZoom   = null;
let _popupFromFind    = false;

map.on('popupopen', function(){
  if(!_popupFromFind){
    _savedPopupCenter = map.getCenter();
    _savedPopupZoom   = map.getZoom();
  }
});

map.on('popupclose', function(){
  if(!_popupFromFind && _savedPopupCenter){
    map.flyTo(_savedPopupCenter, _savedPopupZoom, {animate:true, duration:0.5});
  }
  _savedPopupCenter = null;
  _savedPopupZoom   = null;
  _popupFromFind    = false;
});

/* ── Apply popup default on every open ─────────────────────────────
   Popup HTML is baked at page load, so we can't use a JS variable at
   render time. Instead listen for popupopen and apply compact/full
   based on the CURRENT popupDefault value — works for any dropdown
   change without needing to regenerate the map.                    */
map.on('popupopen', function(e){
  const el = e.popup.getElement();
  if(!el) return;
  const full    = el.querySelector('.p-full');
  const compact = el.querySelector('.p-compact-extra');
  const btn     = el.querySelector('.p-toggle-btn');
  if(!full || !compact) return;
  const isCompact = (popupDefault === 'compact');
  full.style.display    = isCompact ? 'none' : '';
  compact.style.display = isCompact ? ''     : 'none';
  if(btn) btn.textContent = isCompact ? '⊞ Full' : '⊟ Compact';
});

/* Phase 10: begin polling FastChat presence while a popup is open so its
   ⚡ FastChat button reflects live state (enabled vs grayed). */
map.on('popupopen', function(){
  _startFastChatAlivePoll();
});
map.on('popupclose', function(){
  _stopFastChatAlivePoll();
});
// Open a callsign in JS8FastChat. POSTs to JS8Map's own local server, which
// writes the handoff intent file (js8fastchat_intent.json) into JS8Map's data
// folder. JS8FastChat polls that folder and opens its popup pre-targeted.
// JS8FastChat must already be running; this does not launch it.
async function openInFastChat(evt, toCall) {
  evt.stopPropagation();
  // Phase 10: if the button is disabled (FastChat not running) do nothing.
  // The button is normally grayed + disabled, but this guards a stray click.
  if(evt.currentTarget && evt.currentTarget.disabled) return;
  if(_fcAliveLastVal === false) return;
  const safeId = toCall.replace('/','_');
  const statusEl = $('js8-status-' + safeId);
  if(statusEl){ statusEl.textContent = '⚡ Sending ' + toCall + ' to FastChat…'; statusEl.style.color = 'var(--legend-gold)'; }
  try {
    const r = await fetch('/fastchat_handoff', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ call: toCall }),
      signal: AbortSignal.timeout(3000)
    });
    const result = r.ok ? await r.json() : null;
    if(result && result.ok){
      if(statusEl){ statusEl.textContent = '⚡ Opened ' + result.call + ' in FastChat'; statusEl.style.color = '#26a869'; }
    } else {
      const reason = (result && result.reason) ? result.reason : 'no response';
      if(statusEl){ statusEl.textContent = 'FastChat handoff failed: ' + reason; statusEl.style.color = '#ff6b6b'; }
    }
  } catch(e) {
    if(statusEl){ statusEl.textContent = 'FastChat handoff failed (is JS8Map server running?)'; statusEl.style.color = '#ff6b6b'; }
  }
}

async function sendJS8(evt, toCall, mode) {
  evt.stopPropagation();
  const safeId = toCall.replace('/','_');
  const statusEl = $('js8-status-' + safeId);

  // MSG opens the compose popup (type, Enter to send, HALT, Clear) — handled
  // entirely there. SNR?/HEARING? continue through the quick path below.
  if(mode === 'MSG') {
    openComposePopup({
      title: 'Message to ' + toCall,
      prefixLabel: toCall + ' MSG',
      buildFrame: function(t){ return (toCall + ' MSG ' + t).trim(); },
      statusEl: statusEl
    });
    return;
  }

  let text = '';
  const pmode = (mode === 'SNR') ? 'snr' : (mode === 'HEARING') ? 'hearing' : 'msg';

  // Route through the Python TX chokepoint (same origin as the map).
  //   SNR? / HEARING? → mode-aware (auto-send in LIVE, fill box in MANUAL, log in SHADOW)
  //   MSG             → always fills JS8Call's box; operator types/reviews and sends
  let result = null;
  try {
    const r = await fetch('/popup_tx', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ call: toCall, mode: pmode, text: text }),
      signal: AbortSignal.timeout(3000)
    });
    if(r.ok) result = await r.json();
  } catch(e) { result = null; }

  // Build a clipboard backup of the exact frame regardless of outcome.
  const frame = (mode === 'SNR')     ? toCall + ' SNR?'
              : (mode === 'HEARING') ? toCall + ' HEARING?'
              : (toCall + ' MSG ' + text).trim();

  if(!result) {
    // Python unreachable — fall back to clipboard so the operator can paste.
    copyToClipboard(frame, statusEl);
    return;
  }

  _showPopupTxStatus(statusEl, result.effect, frame, toCall, mode);
  // Clipboard backup on staged/shadow paths (handy if box-fill didn't land).
  if(result.effect !== 'sent') { try { navigator.clipboard.writeText(frame); } catch(e){} }
}

function _showPopupTxStatus(statusEl, effect, frame, toCall, mode) {
  if(!statusEl) return;
  const base = 'font-size:12px;font-weight:600;padding:4px 8px;border-radius:5px;margin-top:4px;';
  let html, bg, col;
  if(effect === 'sent') {
    html = '\uD83D\uDCE1 <strong>Transmitted</strong> via JS8Call (LIVE)';
    bg = 'rgba(38,168,105,0.18)'; col = '#26a869';
  } else if(effect === 'staged') {
    html = (mode === 'MSG')
      ? '\uD83D\uDCDD <strong>In JS8Call box</strong> \u2014 review & press send'
      : '\uD83D\uDCDD <strong>Filled JS8Call box</strong> (MANUAL) \u2014 press send';
    bg = 'rgba(224,160,0,0.18)'; col = '#e0a000';
  } else if(effect === 'shadow') {
    html = '\uD83D\uDD34 <strong>SHADOW</strong> \u2014 logged only, no TX';
    bg = 'rgba(136,136,136,0.18)'; col = 'var(--text)';
  } else if(effect === 'badcall') {
    html = '\u26A0 Invalid callsign';
    bg = 'rgba(232,64,96,0.15)'; col = '#e84060';
  } else {
    html = '\uD83D\uDCCB Copied \u2014 paste into JS8Call'; 
    bg = 'rgba(38,168,105,0.15)'; col = 'var(--text)';
  }
  statusEl.innerHTML = html;
  statusEl.style.cssText = base + 'background:' + bg + ';color:' + col + ';';
}

/* ── Compose popup ─────────────────────────────────────────────────────
   A typing window for outgoing messages so the operator never has to switch
   to JS8Call to compose. Used by both the callsign-popup MSG button and the
   relay MSG flow (same window, different call/frame).
     • type the message
     • Enter (or Send) → transmits the full frame via /popup_tx (mode-aware:
       live=transmit, manual=fill box, shadow=log). The compose window IS the
       review step, so Send actually sends in Live.
     • HALT → POST /halt_tx (RIG.TX_HALT). Enabled only if the JS8Call build
       supports it (settings toggle); otherwise greyed with a tooltip pointing
       to JS8Call's own Halt Tx (which is always available since JS8Call is open).
     • ✕ Clear → wipes the box in one click.
   opts: { title, prefixLabel, buildFrame(text)->frame, statusEl, call }      */
let _composeEl = null;
let _composeTimer = null;   // countdown interval after a Live send; cleared on close
function openComposePopup(opts){
  closeComposePopup();
  const haltOn = !!(window.JS8MAP_BOOT && JS8MAP_BOOT.tx_halt_enabled) || _txHaltEnabledLive;
  const box = document.createElement('div');
  _composeEl = box;
  box.id = 'compose-popup';
  box.style.cssText =
    'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001;'+
    'background:#0d1b26;border:2px solid #29b6f6;border-radius:10px;'+
    'box-shadow:0 8px 40px rgba(0,0,0,.75);padding:16px 18px;width:380px;'+
    'font-family:Segoe UI,system-ui,sans-serif;color:#e8eaf0;';
  box.innerHTML =
    '<button id="compose-close" title="Close (Esc)" style="position:absolute;'+
      'top:8px;right:10px;background:transparent;color:#7088a0;border:0;'+
      'font-size:22px;line-height:1;cursor:pointer;padding:2px 7px;'+
      'border-radius:5px;transition:color .12s,background .12s;">&times;</button>'+
    '<div style="font-size:15px;font-weight:700;color:#29b6f6;margin-bottom:4px;padding-right:26px;">'+
      '\u270D\uFE0F '+_esc(opts.title)+'</div>'+
    '<div style="font-family:Consolas,monospace;font-size:12px;color:#7fd4ff;'+
      'opacity:.8;margin-bottom:8px;">'+_esc(opts.prefixLabel)+' <span style="opacity:.5;">\u2026</span></div>'+
    '<textarea id="compose-text" rows="3" placeholder="Type your message, then Enter to send\u2026" '+
      'style="width:100%;box-sizing:border-box;background:#06121a;color:#e8eaf0;'+
      'border:1px solid #1d3a4d;border-radius:5px;padding:8px;font-size:14px;'+
      'font-family:Segoe UI,sans-serif;resize:vertical;outline:none;text-transform:uppercase;"></textarea>'+
    '<div id="compose-status" style="min-height:16px;font-size:12px;margin:6px 0;"></div>'+
    '<div style="display:flex;gap:8px;align-items:center;">'+
      '<button id="compose-send" style="flex:1;background:#26a869;color:#fff;border:0;'+
        'border-radius:5px;padding:9px;font-weight:700;font-size:13px;cursor:pointer;">'+
        '\u25B6 Send  (Enter)</button>'+
      '<button id="compose-halt" '+(haltOn?'':'disabled ')+
        'title="'+(haltOn?'Stop transmission now (RIG.TX_HALT)':'Your JS8Call build has no API halt \u2014 use JS8Call\u2019s Halt Tx button')+'" '+
        'style="background:'+(haltOn?'#c62828':'#3a2a2a')+';color:'+(haltOn?'#fff':'#886')+';'+
        'border:0;border-radius:5px;padding:9px 12px;font-weight:700;font-size:13px;'+
        'cursor:'+(haltOn?'pointer':'not-allowed')+';">\u26D4 HALT</button>'+
      '<button id="compose-clear" title="Clear the message box" '+
        'style="background:#1a2a3a;color:#9fb6cc;border:0;border-radius:5px;'+
        'padding:9px 12px;font-weight:700;font-size:13px;cursor:pointer;">\u2715 Clear</button>'+
    '</div>';
  document.body.appendChild(box);

  const ta = box.querySelector('#compose-text');
  const cstatus = box.querySelector('#compose-status');
  ta.focus();

  // JS8 is uppercase-only — force the actual value to caps as the operator
  // types (CSS text-transform only affects display, not the sent text).
  ta.addEventListener('input', function(){
    const s = ta.selectionStart, e = ta.selectionEnd;
    const up = ta.value.toUpperCase();
    if(up !== ta.value){ ta.value = up; try { ta.setSelectionRange(s, e); } catch(_){} }
  });

  const doSend = async function(){
    const t = ta.value.trim();
    if(!t){ ta.focus(); return; }
    const frame = opts.buildFrame(t);
    cstatus.innerHTML = '\u2026 sending';
    cstatus.style.color = '#7fd4ff';
    let res = null;
    try {
      const r = await fetch('/popup_tx', {method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ call: opts.call || _composeExtractCall(frame),
                               mode:'msg_send', text: t, frame: frame }),
        signal: AbortSignal.timeout(3000)});
      if(r.ok) res = await r.json();
    } catch(e){ res = null; }
    if(!res){
      try { await navigator.clipboard.writeText(frame); } catch(e){}
      cstatus.innerHTML = '\uD83D\uDCCB Python unreachable \u2014 copied to clipboard';
      cstatus.style.color = '#e0a000';
      return;
    }
    if(res.effect === 'sent'){
      // Keep the window open so HALT stays usable during the (slow) JS8
      // transmission. Lock Send + text to prevent an accidental double-send.
      // A ~15s countdown (one Normal TX cycle) auto-closes; the operator can
      // hit X to close early once they're happy and moving on.
      const sendBtn = box.querySelector('#compose-send');
      if(sendBtn){ sendBtn.disabled = true; sendBtn.style.opacity = '0.5';
                   sendBtn.style.cursor = 'default'; sendBtn.textContent = '\u2713 Sent'; }
      ta.readOnly = true; ta.style.opacity = '0.7';
      let _secs = 15;
      const _tick = function(){
        cstatus.innerHTML = '\uD83D\uDCE1 Transmitted (LIVE) \u2014 \u26D4 HALT available'
          + (haltOn ? '' : ' in JS8Call')
          + ' \u00B7 closing in ' + _secs + 's  (\u00D7 to close now)';
        cstatus.style.color = '#26a869';
      };
      _tick();
      _composeTimer = setInterval(function(){
        _secs--;
        if(_secs <= 0){ closeComposePopup(); }
        else { _tick(); }
      }, 1000);
    } else if(res.effect === 'staged'){
      cstatus.innerHTML = '\uD83D\uDCDD Filled JS8Call box (MANUAL) \u2014 press send there';
      cstatus.style.color = '#e0a000';
    } else if(res.effect === 'shadow'){
      cstatus.innerHTML = '\uD83D\uDD34 SHADOW \u2014 logged only, no TX';
      cstatus.style.color = '#9fb6cc';
    } else {
      cstatus.innerHTML = '\u26A0 ' + (res.effect || 'not sent');
      cstatus.style.color = '#e84060';
    }
    if(opts.statusEl) _showPopupTxStatus(opts.statusEl, res.effect, frame, '', 'MSG');
  };

  const doHalt = async function(){
    if(!haltOn) return;
    cstatus.innerHTML = '\u26D4 halting\u2026'; cstatus.style.color = '#ff8a80';
    let res = null;
    try {
      const r = await fetch('/halt_tx', {method:'POST', signal: AbortSignal.timeout(2000)});
      if(r.ok) res = await r.json();
    } catch(e){ res = null; }
    if(res && res.halted){
      cstatus.innerHTML = '\u26D4 TX HALTED \u2014 \u00D7 to close';
      cstatus.style.color = '#ff5252';
    } else {
      cstatus.innerHTML = '\u26A0 Halt not sent ('+((res&&res.reason)||'no response')+') \u2014 use JS8Call\u2019s Halt Tx';
      cstatus.style.color = '#e84060';
    }
    // Stop the auto-close countdown so the operator can read the HALT result.
    if(_composeTimer){ clearInterval(_composeTimer); _composeTimer = null; }
  };

  box.querySelector('#compose-send').onclick  = doSend;
  box.querySelector('#compose-halt').onclick  = doHalt;
  box.querySelector('#compose-clear').onclick = function(){
    ta.value=''; ta.readOnly=false; ta.style.opacity='1'; ta.focus();
    cstatus.innerHTML='';
    if(_composeTimer){ clearInterval(_composeTimer); _composeTimer=null; }
    const sb=box.querySelector('#compose-send');
    if(sb){ sb.disabled=false; sb.style.opacity='1';
            sb.style.cursor='pointer'; sb.textContent='\u25B6 Send  (Enter)'; }
  };
  box.querySelector('#compose-close').onclick = closeComposePopup;
  // Enter sends; Shift+Enter = newline. Esc closes. Once Send is locked
  // (post-send), Enter no longer re-fires.
  ta.addEventListener('keydown', function(e){
    if(e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      if(!box.querySelector('#compose-send').disabled) doSend();
    }
    else if(e.key === 'Escape'){ e.preventDefault(); closeComposePopup(); }
  });
}
function closeComposePopup(){
  if(_composeTimer){ clearInterval(_composeTimer); _composeTimer = null; }
  if(_composeEl){ _composeEl.remove(); _composeEl = null; }
}
function _composeExtractCall(frame){
  // 'KE8OUQ MSG hello' → 'KE8OUQ' ; 'VIA>TGT MSG hi' → 'VIA'
  const m = String(frame).match(/^([A-Z0-9\/]+)/i);
  return m ? m[1].split('>')[0] : '';
}
function _esc(s){ return String(s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

function copyToClipboard(cmd, statusEl) {
  navigator.clipboard.writeText(cmd).then(() => {
    if(statusEl) {
      statusEl.innerHTML = '📋 <strong>Copied!</strong> Paste into JS8Call TX box';
      statusEl.style.color      = 'var(--text)';
      statusEl.style.fontSize   = '12px';
      statusEl.style.fontWeight = '600';
      statusEl.style.background = 'rgba(26,168,105,0.15)';
      statusEl.style.padding    = '4px 8px';
      statusEl.style.borderRadius = '5px';
      statusEl.style.marginTop  = '4px';
    }
  }).catch(() => {
    if(statusEl) {
      statusEl.innerHTML = '⚠ <strong>Type manually:</strong> ' + cmd;
      statusEl.style.color      = 'var(--text)';
      statusEl.style.fontSize   = '12px';
      statusEl.style.fontWeight = '600';
      statusEl.style.background = 'rgba(232,64,96,0.15)';
      statusEl.style.padding    = '4px 8px';
      statusEl.style.borderRadius = '5px';
      statusEl.style.marginTop  = '4px';
    }
  });
}

/* ── Color map — marker dots (from COLORS single source of truth) ── */
const C = {heard:COLORS.heard.dot, hearing_me:COLORS.hearing_me.dot, both:COLORS.both.dot};

/* ── My station — sonar pulse rings ── */
L.marker([MY_LAT,MY_LON], {icon:mkDot('#e84060',20,false,0,false,false,false,0), zIndexOffset:2000})
  .addTo(map)
  .bindPopup(`<div class="p-inner">
    <div class="p-call" style="color:#e84060">📻 ${MY_CALL}</div>
    <span class="p-badge" style="background:#3d0d1a;color:#e84060;">🏠 My Station</span>
    <div class="p-divider"></div>
    <table class="p-table"><tr><td>Grid</td><td>${MY_GRID}</td></tr></table>
  </div>`, {autoPan:true, autoPanPaddingTopLeft:L.point(20,90), autoPanPaddingBottomRight:L.point(20,30)});

(function(){
  const pulseIcon = L.divIcon({
    html:`<div style="position:relative;width:40px;height:40px;">
      <div class="hb-ring"  style="color:#e84060;animation-duration:3s;"></div>
      <div class="hb-ring2" style="color:#e84060;animation-duration:3s;"></div>
    </div>`,
    iconSize:[40,40], iconAnchor:[20,20], className:''
  });
  L.marker([MY_LAT,MY_LON], {icon:pulseIcon, zIndexOffset:1000, interactive:false}).addTo(map);
})();

/* ── Station layers ── */
const LAYERS=[];
const LAYER_MAP={};  // callsign → layer entry, for O(1) lookup in live data updates (B.10)
let heardN=0, hearingN=0, bothN=0, hbN=0, watchedN=0;

STATIONS.forEach(s=>{
  const col  = C[s.type]||'#888';
  const pos  = [s.lat, s.lon];
  const dist = haversine(MY_LAT,MY_LON,s.lat,s.lon);
  const mi   = Math.round(dist*0.621371);

  if(s.type==='heard')           heardN++;
  else if(s.type==='hearing_me') hearingN++;
  else if(s.type==='both')       bothN++;
  if(s.via_hb) hbN++;

  const _lmNow = (typeof currentStyle !== 'undefined' && currentStyle === 'light');
  const line = L.polyline([[MY_LAT,MY_LON],_shortPathEnd(s.lat,s.lon)],{
    color:col,
    weight:  _lmNow ? 2.8 : 1.8,
    opacity: _lmNow ? 0.75 : 0.45,
    dashArray: s.type==='hearing_me'?'6 5':null,
    interactive: false
  }).addTo(map);

  const marker = L.marker(_shortPathEnd(s.lat,s.lon), {icon:mkDot(col,18,s.via_hb,s.heard_by?s.heard_by.length:0,s.approx,s.has_inbox,s.watched,s.station_hears?s.station_hears.length:0)})
    .addTo(map)
    .bindTooltip(mkLabel(s), {
      permanent:true, direction:'right',
      offset:[10,0], className:'station-label' + (s.watched ? ' station-label-watched' : '') + (s.group_color?' station-label-group grp-'+s.group_color.replace('#',''):''), opacity:1
    })
    .bindPopup(mkPopup(s,col,dist,mi), {
      maxWidth:360,
      autoPan:true,
      autoPanPaddingTopLeft:L.point(20,90),
      autoPanPaddingBottomRight:L.point(20,30)
    });

  const _entry={type:s.type, call:s.call, station:s, marker, line};
  LAYERS.push(_entry);
  LAYER_MAP[s.call]=_entry;
});

$('cnt-heard').textContent=heardN;

$('cnt-hearing').textContent=hearingN;
$('cnt-both').textContent=bothN;
$('cnt-total').textContent=STATIONS.length;
if($('cnt-hb'))      $('cnt-hb').textContent     =hbN;
if($('cnt-watched')) $('cnt-watched').textContent=watchedN;
updateLabelSize();
// Refresh active-filter inline style after rebuild
// Deferred so STAT_COLORS is guaranteed defined before first call
setTimeout(function(){
  var _activeStat = document.querySelector('.stat.active-filter');
  if(!_activeStat){
    var _ds = $('cnt-total');
    if(_ds){
      var _dsEl = _ds.closest('.stat');
      _dsEl.classList.add('active-filter');
      _applyStatStyle(_dsEl, 'all', true);
    }
  } else {
    _applyStatStyle(_activeStat, _activeStat.getAttribute('data-filter'), true);
  }
}, 0);

// Restore saved toolbar selections
(function(){
  const animBtn = $('anim-btn');
  if(animBtn) animBtn.textContent = _animEnabled ? '\uD83C\uDFAC Anim On' : '\uD83C\uDFAC Anim Off';
  const popupSel = $('popup-select');
  if(popupSel && (savedPopup==='full'||savedPopup==='compact'))
    popupSel.value = savedPopup;
})();


// ── 🆕 New Callsigns filter ─────────────────────────────────────────────────
let _newMinutes  = 0;
function setNewFilter(minutes){
  _newMinutes = minutes;
  const sel = $('new-filter-select');
  if(minutes > 0){
    if(sel) sel.style.borderColor = '#26a869';
  } else {
    if(sel) sel.style.borderColor = '';
    // Auto-fit when returning to Off so all stations snap back into view
    setTimeout(fitAll, 150);
  }
  applyFilters();
}

// ── 🕐 Active filter (last heard) ───────────────────────────────────────────
// Filters on last_seen (actual decode time) so it lines up with JS8Call's Age
// column — distinct from the New filter, which keys on first_seen_ts.
let _activeMinutes = 0;
function setActiveFilter(minutes){
  _activeMinutes = minutes;
  const sel = $('active-filter-select');
  if(minutes > 0){
    if(sel) sel.style.borderColor = '#26a869';
  } else {
    if(sel) sel.style.borderColor = '';
    // Auto-fit when returning to Off so all stations snap back into view
    setTimeout(fitAll, 150);
  }
  applyFilters();
}

// On subsequent opens the map restores to the last pan/zoom position.
// FitAll once per newly generated map.
// sessionStorage persists across page refreshes in the same tab but not
// across Generate Map (new GENERATE_TS key), so Box Zoom + auto-refresh
// won't fight each other.
if(STATIONS && Object.keys(STATIONS).length > 0){
  const _fitKey = 'fitted_' + GENERATE_TS;
  if(!sessionStorage.getItem(_fitKey)){
    sessionStorage.setItem(_fitKey, '1');
    setTimeout(fitAll, 400);
  }
}

/* ── Startup auto-fit safety net ───────────────────────────────────────
   The main initial fit is now event-driven (in _applyAdditions, the moment
   markers first populate). This short timer is only a fallback for any edge
   case where that didn't run -- e.g. markers present at page load but no
   poll cycle yet. Fires once, 3s after load, only if the user hasn't touched
   the map and there are stations to frame. Shares the same GENERATE_TS key,
   so it never double-fits with the event-driven path.                     */
setTimeout(()=>{
  if(!_userHasMoved && LAYERS.length > 0){
    const _startFitKey = 'fitted_' + GENERATE_TS;
    if(!sessionStorage.getItem(_startFitKey)){
      sessionStorage.setItem(_startFitKey, '1');
      fitAll();
    }
  }
}, 3000);

/* ── Filtering ── */
let activeFilter='all';

/* ── Zoom to callsign ── */
function zoomToCallsign(query) {
  if(!query || !query.trim()) return;
  const q = query.trim().toUpperCase();
  let found = LAYERS.find(l => l.call.toUpperCase() === q);
  if(!found) found = LAYERS.find(l => l.call.toUpperCase().startsWith(q));
  if(!found) found = LAYERS.find(l => l.call.toUpperCase().includes(q));

  if(!found) {
    const el = $('search');
    el.style.borderColor = '#e84060';
    el.style.boxShadow   = '0 0 0 2px rgba(232,64,96,0.35)';
    setTimeout(() => { el.style.borderColor=''; el.style.boxShadow=''; }, 1200);
    return;
  }
  const pos = found.marker.getLatLng();
  // Save current view so we can restore it when the popup closes
  const _preFindCenter = map.getCenter();
  const _preFindZoom   = map.getZoom();
  _popupFromFind = true;   // suppress generic popupclose restore
  _beginProgrammaticFit();
  map.flyTo(pos, Math.max(map.getZoom(), 8), { animate:true, duration:0.8 });
  map.once('moveend', () => {
    found.marker.openPopup();
    // Restore map to pre-find position when this popup closes
    found.marker.once('popupclose', () => {
      map.flyTo(_preFindCenter, _preFindZoom, { animate:true, duration:0.6 });
    });
    const el = found.marker.getElement();
    if(el) {
      el.style.filter = 'brightness(1.8) drop-shadow(0 0 8px gold)';
      setTimeout(() => { el.style.filter = ''; }, 2000);
    }
  });
  $('search').value = found.call;
  applyFilters();
}

// Active-filter colors per filter: [dark border, dark rgba, light border, light rgba]
// NOTE: these are filter-button-specific tuned shades, kept separate from COLORS
// on purpose (tuned for button border visibility). Edit here for filter buttons.
var STAT_COLORS = {
  heard:      ['#29b6f6','41,182,246',  '#0277bd','2,119,189'],
  hearing_me: ['#66bb6a','102,187,106', '#2e7d32','46,125,50'],
  both:       ['#ffa726','255,167,38',  '#e65100','230,81,0'],
  via_hb:     ['#FFD700','255,215,0',   '#f9a825','249,168,37'],
  watched:    ['#ff8f00','255,143,0',   '#e65100','230,81,0'],
  all:        ['#e8eaf0','232,234,240', '#37474f','55,71,79']
};

function _applyStatStyle(statEl, filter, active) {
  // The header is navy in both map themes (2026-10-14e), so the stat boxes
  // always use the dark-header highlight.
  var isLight = false;
  if(!active) {
    statEl.style.borderColor = '';
    statEl.style.boxShadow   = '';
    statEl.style.borderBottomWidth = '';
    statEl.style.background  = '';
    return;
  }
  var c = STAT_COLORS[filter] || STAT_COLORS['all'];
  if(isLight) {
    statEl.style.borderColor       = c[2];
    statEl.style.boxShadow         = '0 0 0 2px rgba('+c[3]+',0.30)';
    statEl.style.borderBottomWidth = '3px';
    statEl.style.background        = 'rgba(0,0,0,0.06)';
  } else {
    statEl.style.borderColor       = c[0];
    statEl.style.boxShadow         = '0 0 0 2px rgba('+c[1]+',0.30), 0 0 12px rgba('+c[1]+',0.18)';
    statEl.style.borderBottomWidth = '';
    statEl.style.background        = 'rgba(255,255,255,0.06)';
  }
}

function quickFilter(f){
  activeFilter = f;
  var idMap = {all:'cnt-total', heard:'cnt-heard', hearing_me:'cnt-hearing', both:'cnt-both', via_hb:'cnt-hb', watched:'cnt-watched'};
  document.querySelectorAll('.stat').forEach(function(s){
    s.classList.remove('active-filter');
    var df = s.getAttribute('data-filter');
    _applyStatStyle(s, df, false);
  });
  var el = $(idMap[f]);
  if(el){
    var st = el.closest('.stat');
    st.classList.add('active-filter');
    _applyStatStyle(st, f, true);
  }
  applyFilters();
}

function fitAll(){
  _userHasMoved = false;   // user explicitly triggered fit — re-enable auto-expand
  // Collect latlngs from all currently-visible markers (respects active filter).
  // Excludes: stations outside USA/Canada/Caribbean zone, and per-callsign exclusions.
  const pts = [];
  LAYERS.forEach(l=>{
    if(!map.hasLayer(l.marker)) return;
    const ll = l.marker.getLatLng();
    if(!ll) return;
    if(FIT_EXCLUSIONS.has(l.call)) return;
    const lat=ll.lat, lon=ll.lng;
    if(lat<FIT_LAT_MIN||lat>FIT_LAT_MAX||lon<FIT_LON_MIN||lon>FIT_LON_MAX) return;
    pts.push(ll);
  });
  // StatRep diamonds and MCForms squares on the map count too (17c): a
  // report can still be in the StatRep time window after its sender's dot
  // has aged out of the station window, and Fit All must not hide it.
  try {
    [_srMarkers, _mfMarkers].forEach(function(set){
      Object.keys(set).forEach(function(k){
        const m = set[k];
        if(!m || !map.hasLayer(m)) return;
        const ll = m.getLatLng();
        if(ll && ll.lat >= FIT_LAT_MIN && ll.lat <= FIT_LAT_MAX &&
           ll.lng >= FIT_LON_MIN && ll.lng <= FIT_LON_MAX) pts.push(ll);
      });
    });
  } catch(e){}            // markers not created yet during page start-up
  pts.push(L.latLng(MY_LAT, MY_LON));
  if(pts.length < 2){ map.setView([MY_LAT, MY_LON], 6); return; }
  const bounds = L.latLngBounds(pts);
  _beginProgrammaticFit();
  map.fitBounds(bounds, {padding:[14,14], maxZoom:10});
  setTimeout(()=>{ if(map.getZoom() < 5) map.setZoom(map.getZoom()+1); }, 50);
}

/* ── Expand-only fit for new arrivals ─────────────────────────────────
   Called from _applyAdditions with [lat, lon, call] tuples for every
   station added this cycle. Extends the viewport to show out-of-bounds
   arrivals — but only if the user has not manually panned or zoomed
   since the last fit. Respects FIT_EXCLUSIONS and the same geographic
   zone fitAll uses. maxZoom: map.getZoom() ensures we never zoom in,
   only out.                                                             */
function _fitForNewStations(oob){
  if(_userHasMoved || oob.length === 0) return;

  // Honour the same exclusion rules as fitAll
  const eligible = oob.filter(([lat, lon, call])=>
    !FIT_EXCLUSIONS.has(call) &&
    lat >= FIT_LAT_MIN && lat <= FIT_LAT_MAX &&
    lon >= FIT_LON_MIN && lon <= FIT_LON_MAX
  );
  if(eligible.length === 0) return;

  // Only act on positions genuinely outside the current viewport
  const cur = map.getBounds();
  const toAdd = eligible.filter(([lat, lon])=> !cur.contains([lat, lon]));
  if(toAdd.length === 0) return;

  // Extend bounds to cover all new out-of-bounds arrivals at once
  let bounds = cur;
  toAdd.forEach(([lat, lon])=>{ bounds = bounds.extend([lat, lon]); });

  _userHasMoved = false;
  _beginProgrammaticFit();
  map.flyToBounds(bounds, {
    padding: [60, 60],
    animate: true,
    duration: 0.8,
    maxZoom: map.getZoom()   // expand only, never zoom in
  });
}
let _boxMode  = false;
let _boxStart = null;
let _boxEl    = null;

function _mkBoxEl(){
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;border:2px dashed #29b6f6;'
    + 'background:rgba(41,182,246,0.12);pointer-events:none;z-index:9999;display:none;';
  document.body.appendChild(el);
  return el;
}

function _updateBox(el, x1, y1, x2, y2){
  Object.assign(el.style, {
    left: Math.min(x1,x2)+'px', top: Math.min(y1,y2)+'px',
    width: Math.abs(x2-x1)+'px', height: Math.abs(y2-y1)+'px', display:'block'
  });
}

function _finishBox(x1, y1, x2, y2){
  if(_boxEl){ _boxEl.remove(); _boxEl = null; }
  if(Math.abs(x2-x1) < 10 || Math.abs(y2-y1) < 10) return;
  const r = $('map').getBoundingClientRect();
  const sw = map.containerPointToLatLng(L.point(Math.min(x1,x2)-r.left, Math.max(y1,y2)-r.top));
  const ne = map.containerPointToLatLng(L.point(Math.max(x1,x2)-r.left, Math.min(y1,y2)-r.top));
  _beginProgrammaticFit();
  map.fitBounds(L.latLngBounds(sw, ne));
}

/* ── Legend toggle ─────────────────────────────────────────────── */
function toggleLegend(){
  const leg = $('legend');
  const tab = $('legend-tab');
  const open = leg.style.display !== 'none';
  leg.style.display = open ? 'none' : 'block';
  tab.style.display = open ? 'block' : 'none';
  sessionStorage.setItem('legendOpen', open ? '0' : '1');
  if(typeof _srPlace === 'function') _srPlace();   // keep StatRep board above the legend
}
(function(){
  if(sessionStorage.getItem('legendOpen') === '1'){
    $('legend').style.display = 'block';
    $('legend-tab').style.display = 'none';
  }
})();

function toggleDrawBox(){
  _boxMode = !_boxMode;
  const btn = $('drawbox-btn');
  if(_boxMode){
    btn.style.cssText += 'background:#29b6f6!important;color:#0d1b2a!important;';
    btn.textContent = '📐 Drawing…';
    $('map').style.cursor = 'crosshair';
    _kbToast('📐 Box Zoom — drag to select area. Esc to cancel.');
  } else {
    btn.style.background = btn.style.color = '';
    btn.textContent = '📐 Box Zoom';
    $('map').style.cursor = '';
    if(_boxEl){ _boxEl.remove(); _boxEl = null; }
  }
}

(function(){
  const getMap = () => $('map');
  document.addEventListener('mousedown', function(e){
    const inMap = getMap() && getMap().contains(e.target);
    if(!inMap) return;
    const rightClick = (e.button === 2);
    if(!_boxMode && !rightClick) return;
    e.preventDefault(); e.stopPropagation();
    _boxStart = {x: e.clientX, y: e.clientY};
    _boxEl = _mkBoxEl();
    map.dragging.disable();
    function onMove(ev){ if(_boxStart) _updateBox(_boxEl,_boxStart.x,_boxStart.y,ev.clientX,ev.clientY); }
    function onUp(ev){
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      map.dragging.enable();
      if(_boxStart){ _finishBox(_boxStart.x,_boxStart.y,ev.clientX,ev.clientY); _boxStart=null; }
      if(_boxMode) toggleDrawBox();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, true);
  document.addEventListener('contextmenu', function(e){
    if(getMap() && getMap().contains(e.target)) e.preventDefault();
  }, true);
})();
function applyFilters(){
  const q=$('search').value.trim().toUpperCase();
  const newCutoffMs = _newMinutes > 0 ? Date.now() - _newMinutes * 60 * 1000 : 0;
  const activeCutoffMs = _activeMinutes > 0 ? Date.now() - _activeMinutes * 60 * 1000 : 0;
  LAYERS.forEach(l=>{
    const typeOk=activeFilter==='all'||l.type===activeFilter||
                 (activeFilter==='via_hb'&&l.station&&l.station.via_hb)||
                 (activeFilter==='watched'&&l.station&&l.station.watched);
    const callOk=!q||l.call.startsWith(q);
    const relayOk = !_relayTarget ||
      l.call === MY_CALL ||
      l.call === _relayTarget ||
      (l.call !== MY_CALL && _mergeRelay(_relayTarget).some(r => r.via === l.call));
    const newOk = !newCutoffMs || !l.station.first_seen_ts ||
      tsToMsUTC(l.station.first_seen_ts) >= newCutoffMs;
    // Active filter: keep stations last heard within the window (matches JS8Call Age).
    // If a station has no last_seen, don't hide it on this filter's account.
    const activeOk = !activeCutoffMs || !l.station.last_seen ||
      tsToMsUTC(l.station.last_seen) >= activeCutoffMs;
    const _grpEl2=$('group-filter');
    const grpFilter=_grpEl2?_grpEl2.value:'';
    const grpOk=!grpFilter||(l.station&&l.station.group_all&&grpFilter in l.station.group_all);
    const chainOk = !_chainVia ||
      l.call === _chainVia ||
      l.call === _chainTarget;
    // CommStat Only view: hide every station except my own; StatRep
    // diamonds live in their own pane and are untouched. (window flag --
    // applyFilters runs before the StatRep block has loaded.)
    // QSO Only view: also keep the stations in a QSO (window._QSO_CALLS).
    const _qsoView = window.SR_VIEW === 'qso';
    const srOnlyOk = !window.SR_ONLY || l.call === MY_CALL ||
      (_qsoView && window._QSO_CALLS && window._QSO_CALLS.has(String(l.call).split('/')[0].toUpperCase()));
    const show=typeOk&&callOk&&relayOk&&newOk&&activeOk&&grpOk&&chainOk&&srOnlyOk;
    const hasMk=map.hasLayer(l.marker);
    const hasLn=map.hasLayer(l.line);
    if(show){
      if(!hasMk)map.addLayer(l.marker);
      if(_qsoView){ if(hasLn) map.removeLayer(l.line); }   // QSO Only: QSO lines only
      else if(!hasLn)map.addLayer(l.line);
      // Restyle border to match active group filter — must run AFTER addLayer
      // so getElement() returns the live DOM node.
      if(l.station&&l.station.group_all){
        const all=l.station.group_all;
        const useColor=grpFilter&&all[grpFilter]?all[grpFilter]:l.station.group_color;
        if(useColor){
          const el=l.marker.getElement();
          if(el){
            el.querySelectorAll('.station-label-group').forEach(function(node){
              Array.from(node.classList).filter(function(c){return c.startsWith('grp-');})
                .forEach(function(c){node.classList.remove(c);});
              node.classList.add('grp-'+useColor.replace('#',''));
            });
          }
        }
      }
    }
    else{ if(hasMk)map.removeLayer(l.marker); if(hasLn)map.removeLayer(l.line); }
  });
}

/* ── Relay filter ────────────────────────────────────────────────────
   Dims all stations except those confirmed as relay paths to target.
   Relay banner shown at top of map when active.                     */

function _restoreRelayLines(){
  Object.entries(_relayLineColors).forEach(([call,orig])=>{
    const lay=LAYERS.find(l=>l.call===call);
    if(lay&&lay.line) lay.line.setStyle({color:orig.c,weight:orig.w,opacity:orig.o});
  });
  _relayLineColors={};
}

function _colorRelayLines(paths){
  _restoreRelayLines();
  const palette=['#e040fb','#00e676','#ff9100','#ff3d00'];
  paths.filter(r=>r.via!==MY_CALL).slice(0,4).forEach((r,i)=>{
    const lay=LAYERS.find(l=>l.call===r.via);
    if(lay&&lay.line&&map.hasLayer(lay.line)){
      const o=lay.line.options;
      _relayLineColors[r.via]={c:o.color||'#4466aa',w:o.weight||1.5,o:o.opacity||0.6};
      lay.line.setStyle({color:palette[i],weight:3.5,opacity:0.92});
      lay.line.bringToFront();
    }
  });
}

function _mergeRelay(tgt){
  const byVia={};
  (RELAY_PATHS[tgt]||[]).forEach(p=>byVia[p.via]={...p});
  (_liveRelay[tgt]||[]).forEach(p=>{
    if(!byVia[p.via]) byVia[p.via]={...p};
    else if(p.snr!=null) byVia[p.via]=Object.assign({},byVia[p.via],
      {snr:p.snr,age_min:p.age_min,confidence:p.confidence,
        composite:byVia[p.via].composite!=null?byVia[p.via].composite:p.snr});
  });
  return Object.values(byVia).sort((a,b)=>
    -((a.composite!=null?a.composite:a.snr!=null?a.snr:-99)
     -(b.composite!=null?b.composite:b.snr!=null?b.snr:-99)));
}

function applyRelayFilter(target){
  _relayTarget = target ? target.toUpperCase().trim() : '';
  const clr=$('relay-clear');
  if(clr) clr.style.display=_relayTarget?'block':'none';

  let banner=$('relay-banner');
  if(_relayTarget){
    const paths=_mergeRelay(_relayTarget).filter(r=>r.via!==MY_CALL);
    if(!banner){
      banner=document.createElement('div');
      banner.id='relay-banner';
      banner.style.cssText='position:fixed;top:58px;left:50%;transform:translateX(-50%);'
        +'background:rgba(15,60,100,0.95);color:#fff;font-family:var(--font-main);'
        +'font-size:13px;font-weight:700;padding:7px 20px;border-radius:20px;z-index:9998;'
        +'box-shadow:0 2px 12px rgba(0,0,0,0.5);pointer-events:auto;white-space:nowrap;'
        +'border:1px solid rgba(41,182,246,0.5);';
      document.body.appendChild(banner);
    }
    if(paths.length>0){
      // Build clickable via buttons with per-rank palette colors
      const palette=['#e040fb','#00e676','#ff9100','#ff3d00'];
      const btnHtml = paths.slice(0,4).map((r,i)=>{
        const l1=r.snr_to_me!=null?`${r.snr_to_me>0?'+':''}${Math.round(r.snr_to_me)}`:'?';
        const l2=r.snr!=null?`${r.snr>0?'+':''}${Math.round(r.snr)}`:'?';
        const age=r.age_min<2?'now':`${r.age_min}m`;
        const col = palette[i] || '#aaaaaa';
        const sel  = _chainVia===r.via  ? ' chain-via-selected' : '';
        const lock = (_chainCommitted&&_chainVia!==r.via) ? ' chain-via-locked' : '';
        const star = i===0 ? '&#x2605; ' : '';
        // Inline color + CSS variable for pulse glow
        const styleBase = `color:${col};border-color:${col};--via-glow:${col};`+
          `background:${col}18;`;
        return `<button class="chain-via-btn${sel}${lock}" `+
               `style="${styleBase}" `+
               `onclick="if(!_chainCommitted)_selectChainVia('${r.via}')" `+
               `title="${r.via}: ${l1}→${l2}dB (${age})">`+
               `${star}${r.via}`+
               `<span class="chain-via-snr">${l1}→${l2}dB (${age})</span>`+
               `</button>`;
      }).join(' ');
      const moreHtml = paths.length>4
        ? `<span class="chain-more">+${paths.length-4} more</span>` : '';
      const goHtml = _chainCommitted
        ? `<button class="chain-go-btn chain-go-active" title="Relay command in clipboard">&#x2713; Active</button>`
        : (_chainVia
          ? `<button class="chain-go-btn" onclick="_commitChain()">&#x25BA; GO</button>`
          : '');
      const exitHtml = (_chainVia||_chainCommitted)
        ? `<button class="chain-exit-btn chain-paths-btn" onclick="_chainBackToPaths()" title="Back to all relay paths">&#x2190; Paths</button>`+
          `<button class="chain-exit-btn chain-done-btn" onclick="clearChain()" title="Exit relay, return to full map">&#x2715; Done</button>`
        : `<button class="chain-exit-btn chain-refresh-btn" style="border-color:#29b6f6;color:#29b6f6;background:#29b6f618;" onclick="_refreshRelayPaths(this)" title="Pull fresh decodes and re-plot newly-discovered vias">&#x27F3; Refresh paths</button>`+
          `<button class="chain-exit-btn chain-done-btn" onclick="clearChain()">&#x2715; Done</button>`;
      banner.innerHTML=`&#x1F501; Relay to <b style="color:#29b6f6;">${_relayTarget}</b>: `+
        btnHtml+moreHtml+goHtml+exitHtml;
      applyFilters();
      if(!_chainVia) _colorRelayLines(paths);  // only color lines when no via selected
    }else{
      banner.innerHTML=`&#x1F501; Relay to <b style="color:#29b6f6;">${_relayTarget}</b>: `+
        `No paths — enter <b>${_relayTarget}</b> in &#x1F501; field on JS8Map and press <b>Search</b>`;
      applyFilters();
      _restoreRelayLines();
    }
  if(target) _kbToast(`🔁 Relay filter: ${target}`);
  // Notify Python to suspend/resume auto-refresh while relay filter is active
  fetch('/relay_active',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({active:!!_relayTarget})}).catch(()=>{});
  }else{
    if(banner) banner.remove();
    _clearChainLegs();
    _chainVia=null; _chainCommitted=false;
    applyFilters();
    _restoreRelayLines();
  }
}

/* ── Manual relay path refresh ─────────────────────────────────────────
   Forces JS8Map (Python) to rebuild the map from the latest decodes so
   newly-discovered YES vias get plotted and gain map lines. The auto
   rebuild already fires ~5s after a YES burst settles; this button is the
   manual backup for when you want to pull immediately. After the regen,
   the next /data.json poll adds the new station markers; we re-run
   applyRelayFilter on a short delay so the new vias get colored lines.  */
function _refreshRelayPaths(btn){
  if(!_relayTarget) return;
  const orig = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled=true; btn.innerHTML='&#x27F3; Refreshing…'; }
  // Tell Python the relay is in discovery (armed, not committed) so it knows
  // a rebuild is safe, then trigger the rebuild.
  fetch('/refresh',{method:'POST'}).catch(()=>{});
  // Poll fresh data + re-color shortly after the regen lands. Two passes
  // (1.5s and 4s) cover both fast DB regen and the JS8Call poll round-trip.
  const _reapply = ()=>{
    fetch('/data.json?_='+Date.now()).then(r=>r.json()).then(data=>{
      if(data && data.ts){ _lastDataTs=data.ts; _latestData=data; _applyAdditions(data); }
      if(_relayTarget) applyRelayFilter(_relayTarget);
    }).catch(()=>{ if(_relayTarget) applyRelayFilter(_relayTarget); });
  };
  setTimeout(_reapply, 1500);
  setTimeout(()=>{
    _reapply();
    if(btn){ btn.disabled=false; btn.innerHTML=orig; }
    _kbToast('\uD83D\uDD01 Relay paths refreshed');
  }, 4000);
}

/* ── Relay Chain Mode (B.15) ───────────────────────────────────────────
   Selecting a via callsign in the relay banner starts "explore" mode:
     - Two chain legs drawn (KW3KW→via solid, via→target dashed)
     - Selected button pulses; others dim
     - Map shows only 3 stations via chainOk in applyFilters()
   Pressing GO stages the selection (does NOT transmit):
     - Python fills JS8Call's outgoing box with 'VIA>TARGET ' (TX.SET_TEXT)
       and copies the same to the clipboard as a backup
     - A popup tells the operator to type their message in JS8Call and send
     - Button stops pulsing, goes solid; GO → "✓ Active"
   clearChain() resets everything back to relay filter view.        */

function _selectChainVia(via){
  if(_chainCommitted) return;
  _chainVia = via;
  _clearChainLegs();
  _drawChainLegs();
  applyFilters();
  // Redraw banner to update pulse/dim states
  applyRelayFilter(_relayTarget);
}

function _relayFromPopup(via){
  // Called by the callsign-popup "Relay to <target>" button. Runs the SAME
  // commit path as the GO button so the relay state machine arms and the comet
  // animation fires — previously this opened the compose window directly and
  // bypassed the commit, so the message sent but nothing animated.
  if(!_relayTarget) return;
  _chainTarget = _relayTarget;
  _chainVia = via;
  _chainCommitted = false;     // let _commitChain set it
  _relayAnimState = null;      // allow fresh animation to trigger
  _clearChainLegs();
  _drawChainLegs();
  _commitChain();              // commits via /relay_commit (arms animation) + opens compose
}

function _commitChain(){
  if(!_chainVia || !_chainTarget) return;
  _chainCommitted = true;
  // Staging prefix — trailing space so the cursor lands ready to type the
  // message. Matches the prefix Python stages into JS8Call via TX.SET_TEXT.
  const cmd = _chainVia+'>'+_chainTarget+' ';
  _chainMsgPrefix = cmd;   // C.18: store for Switch Path clipboard reconstruction
  _copyToClipboard(cmd);   // clipboard backup (your "both" choice)
  fetch('/relay_commit', {method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({via:_chainVia, target:_chainTarget, msg:''})
  }).catch(function(){});
  applyRelayFilter(_relayTarget);  // refresh banner: GO → Active
  // Open the SAME compose popup used by the callsign-popup MSG button, so relay
  // messages are composed in-app and consistent. Send transmits the full
  // VIA>TARGET <msg> frame (mode-aware). Relay state/animation already armed above.
  const _via = _chainVia, _tgt = _chainTarget;
  openComposePopup({
    title: 'Relay via ' + _via + ' \u2192 ' + _tgt,
    prefixLabel: _via + '>' + _tgt,
    call: _via,
    buildFrame: function(t){ return (_via + '>' + _tgt + ' ' + t).trim(); },
    statusEl: null
  });
}

/* ── Relay staged notification ─────────────────────────────────────────
   After GO, Python fills JS8Call's outgoing box (TX.SET_TEXT) with
   'VIA>TARGET ' and copies the same to the clipboard. This popup tells the
   operator the relay is staged and that THEY must type the message and press
   send in JS8Call — nothing transmits automatically.                     */
function _showRelayStagedPopup(via, tgt){
  var old = document.getElementById('relay-staged-modal');
  if(old) old.remove();
  var box = document.createElement('div');
  box.id = 'relay-staged-modal';
  box.style.cssText =
    'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);'+
    'z-index:10000;background:#0d1b26;border:2px solid #29b6f6;border-radius:10px;'+
    'box-shadow:0 8px 40px rgba(0,0,0,.7);padding:18px 22px;max-width:380px;'+
    'font-family:Segoe UI,system-ui,sans-serif;color:#e8eaf0;';
  box.innerHTML =
    '<div style="font-size:15px;font-weight:700;color:#29b6f6;margin-bottom:8px;">'+
      '📝 Relay staged — ready for your message</div>'+
    '<div style="font-size:13px;line-height:1.5;margin-bottom:6px;">'+
      'JS8Call\u2019s outgoing box now holds:</div>'+
    '<div style="font-family:Consolas,monospace;font-size:14px;background:#06121a;'+
      'border:1px solid #1d3a4d;border-radius:5px;padding:7px 10px;margin-bottom:10px;'+
      'color:#7fd4ff;">'+via+'&gt;'+tgt+' <span style="opacity:.5;">\u2588</span></div>'+
    '<div style="font-size:13px;line-height:1.5;margin-bottom:14px;">'+
      'Switch to <b>JS8Call</b>, type your message after the prefix, and press '+
      '<b>send</b> there. Nothing transmits automatically.<br>'+
      '<span style="opacity:.6;font-size:12px;">(Also copied to clipboard as backup — '+
      'paste if the box is empty.)</span></div>'+
    '<div style="text-align:right;">'+
      '<button onclick="document.getElementById(\'relay-staged-modal\').remove()" '+
      'style="background:#29b6f6;color:#06121a;border:0;border-radius:5px;'+
      'padding:7px 16px;font-weight:700;cursor:pointer;font-size:13px;">Got it</button>'+
    '</div>';
  document.body.appendChild(box);
  // Auto-dismiss after 12s so it never lingers if the operator moved on.
  setTimeout(function(){
    var b = document.getElementById('relay-staged-modal');
    if(b) b.remove();
  }, 12000);
}

function _copyToClipboard(text){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).catch(()=>_legacyCopy(text));
  } else {
    _legacyCopy(text);
  }
}
function _legacyCopy(text){
  const ta=document.createElement('textarea');
  ta.value=text;
  ta.style.cssText='position:fixed;top:-9999px;left:-9999px;';
  document.body.appendChild(ta);
  ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta);
}

let _chainLegsWaitVia = false;   // legs not drawn yet: via has no map dot (17d)
function _drawChainLegs(){
  if(!_chainVia) return;
  const CC = '#e040fb';
  const CW = 2.2;

  // Leg 1: MY_CALL → via  (solid — path KW3KW can directly hear)
  const viaEntry = LAYER_MAP[_chainVia];
  // 17d FIX: a via can be picked from the relay paths before its dot is on
  // the map (it arrives with the next data poll). Drawing then skipped leg 1
  // and started leg 2 at MY station, so the map showed a line straight to
  // the target and the animation ran down it first, with no second leg to
  // continue on. Now nothing is drawn until the via's dot exists; the data
  // poll redraws as soon as it appears (see _chainLegsWaitVia below).
  if(!viaEntry || !viaEntry.marker){ _chainLegsWaitVia = true; return; }
  _chainLegsWaitVia = false;
  if(viaEntry && viaEntry.marker){
    const vp = viaEntry.marker.getLatLng();
    const leg1 = L.polyline([[MY_LAT,MY_LON],[vp.lat,vp.lng]],{
      color:CC, weight:CW, opacity:0.95
    }).addTo(map);
    leg1.bringToFront();
    _chainLegs.push(leg1);
  }

  // Leg 2: via → target  (dashed — remote hop KW3KW cannot directly hear)
  const tLat = _chainTargetPos ? _chainTargetPos.lat : null;
  const tLon = _chainTargetPos ? _chainTargetPos.lon : null;
  const tGrid= _chainTargetPos ? _chainTargetPos.grid : '';
  if(tLat && tLon){
    const vp2 = viaEntry ? viaEntry.marker.getLatLng() : {lat:MY_LAT,lng:MY_LON};
    const leg2 = L.polyline([[vp2.lat,vp2.lng],[tLat,tLon]],{
      color:CC, weight:CW, opacity:0.80, dashArray:'10 7'
    }).addTo(map);
    leg2.bringToFront();
    _chainLegs.push(leg2);

    // Target diamond marker
    const sub = tGrid
      ? `<div class="chain-target-sub">${tGrid} ≈FCC</div>`
      : '<div class="chain-target-sub">approx</div>';
    _chainMarker = L.marker([tLat,tLon],{
      icon:L.divIcon({
        html:`<div class="chain-target-label">`+
             `<div class="chain-dot-wrap"><div class="chain-target-dot"></div></div>`+
             `<div class="chain-target-callsign">${_chainTarget}</div>`+sub+
             `</div>`,
        className:'', iconAnchor:[0,0]
      }),
      zIndexOffset:1000
    }).addTo(map);

    // Fit all 3 into view
    const pts=[[MY_LAT,MY_LON],[tLat,tLon]];
    if(viaEntry && viaEntry.marker){
      const vp=viaEntry.marker.getLatLng();
      pts.push([vp.lat,vp.lng]);
    }
    _beginProgrammaticFit();
    map.fitBounds(L.latLngBounds(pts),{padding:[60,60],maxZoom:8});
  }
}

function _clearChainLegs(){
  _chainLegs.forEach(l=>{ try{ map.removeLayer(l); }catch(e){} });
  _chainLegs=[];
  if(_chainMarker){ try{ map.removeLayer(_chainMarker); }catch(e){} _chainMarker=null; }
}

function _chainBackToPaths(){
  _stopCometAnims();
  // Do NOT reset _relayAnimState here — keeping it prevents the 1s poll
  // from re-triggering _handleRelayAnim with the old Python state, which
  // would spuriously restart comets if the user quickly selects a new via.
  _chainVia=null; _chainCommitted=false;
  _clearChainLegs();
  _userHasMoved = true;   // prevent auto-fit on relay filter change
  applyFilters();
  _colorRelayLines(_mergeRelay(_relayTarget));
  applyRelayFilter(_relayTarget);
  _kbToast('Back to relay paths');
}

/* ── Relay Phase 2: Chain Hop Animation ─────────────────────────────
   Comet-tail animation driven by /relay_anim.json polling (1s interval).
   States: leg1_tx → leg2_fwd → rtn_leg1 → rtn_leg2 → complete.         */

function _stopCometAnims() {
  _relayAnimStops.forEach(function(fn){ fn(); });
  _relayAnimStops = [];
  _relayAnimLegs.forEach(function(l){ try{ map.removeLayer(l); } catch(e){} });
  _relayAnimLegs = [];
  _chainLegs.forEach(function(l){ if(l && l._path) l._path.style.animation = ''; });
  _closeRelayLagPopup();
}

function _closeRelayLagPopup() {
  var el = document.getElementById('relay-lag-banner');
  if(el){ el.style.display = 'none'; el.className = ''; }
}

function _showRelayLagPopup() {
  _closeRelayLagPopup();
  var el = document.getElementById('relay-lag-banner');
  if(!el) return;
  el.textContent = '⏱ Return path — ~1 TX behind';
  el.style.display = 'block';
  el.className = 'pulsing';
  // After 5 pulses (5s) switch to solid
  setTimeout(function(){
    if(el.style.display === 'block'){ el.className = 'solid'; }
  }, 5000);
}

function _showRelayBreakdownPopup(anim) {
  _closeRelayLagPopup();
  // Anchor to via position from leg geometry — no LAYER_MAP dependency.
  var ll = null;
  if(_chainLegs[0]) {
    var lls = _chainLegs[0].getLatLngs();
    if(lls && lls.length >= 2) ll = lls[lls.length - 1];
  }
  if(!ll && _chainLegs[1]) {
    var lls2 = _chainLegs[1].getLatLngs();
    if(lls2 && lls2.length >= 2) ll = lls2[0];
  }
  if(!ll) return;
  var tgt = (anim && anim.target) || _chainTarget || '?';
  _relayStatusPopup = L.popup({
    closeButton:false, autoClose:false, closeOnClick:false,
    className:'relay-warn-popup', offset:[0, -8]
  })
  .setLatLng(ll)
  .setContent('⚠ Relay timeout — no response from ' + tgt)
  .openOn(map);
}

function _setLegPassedOff(legIdx, color) {
  var leg = _chainLegs[legIdx];
  if(!leg) return;
  leg.setStyle({color: color, opacity: 0.6});
  if(leg._path) leg._path.style.animation = 'relay-passed-off 2s ease-in-out infinite';
}

function _startComet(legIdx, reverse, color, dur, onDone) {
  var baseLeg = _chainLegs[legIdx];
  if(!baseLeg) return function(){};
  var latlngs = baseLeg.getLatLngs();
  if(!latlngs || latlngs.length < 2) return function(){};

  var fromLL = reverse ? latlngs[latlngs.length - 1] : latlngs[0];
  var toLL   = reverse ? latlngs[0] : latlngs[latlngs.length - 1];

  // Outer glow ring
  var glow = L.circleMarker(fromLL, {
    radius:14, color:color, weight:0,
    fillColor:color, fillOpacity:0.18, interactive:false
  }).addTo(map);
  // Core comet dot
  var core = L.circleMarker(fromLL, {
    radius:6, color:'#fff', weight:2,
    fillColor:color, fillOpacity:1.0, interactive:false
  }).addTo(map);
  _relayAnimLegs.push(glow, core);

  var running = true, startTs = null, fired = false, rafId;

  function frame(now) {
    if(!running) return;
    if(!startTs) startTs = now;
    var elapsed = (now - startTs) / 1000;
    var cycle   = Math.floor(elapsed / dur);
    var t       = (elapsed % dur) / dur;
    if(onDone && cycle >= 1 && !fired){
      fired = true; running = false;
      try{ map.removeLayer(glow); map.removeLayer(core); }catch(e){}
      onDone(); return;
    }
    var lat = fromLL.lat + (toLL.lat - fromLL.lat) * t;
    var lng = fromLL.lng + (toLL.lng - fromLL.lng) * t;
    glow.setLatLng([lat, lng]);
    core.setLatLng([lat, lng]);
    glow.setStyle({ fillOpacity: 0.12 + 0.18 * Math.sin(t * Math.PI) });
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  var stopFn = function() {
    running = false;
    if(rafId) cancelAnimationFrame(rafId);
    try{ map.removeLayer(glow); map.removeLayer(core); }catch(e){}
  };
  _relayAnimStops.push(stopFn);
  return stopFn;
}

function _handleRelayAnim(anim) {
  if(!_chainCommitted || !_chainLegs.length) return;
  _stopCometAnims();
  switch(anim.state) {
    case 'leg1_tx':
      _startComet(0, false, '#e040fb', 8, null);
      break;
    case 'leg2_fwd':
      _setLegPassedOff(0, '#00e676');
      // 45s single-pass comet — stops after one traverse even if rtn_leg1 hasn't fired.
      // Prevents comet looping while KO4BIA is already transmitting the return.
      // After comet finishes, leg1 stays visible as a pulsing purple line (in-flight).
      _startComet(1, false, '#e040fb', 45, function(){
        _setLegPassedOff(1, '#e040fb');
      });
      break;
    case 'rtn_leg1':
      _setLegPassedOff(0, '#00e676');
      _startComet(1, true,  '#29b6f6', 10, null);
      _showRelayLagPopup();
      break;
    case 'rtn_leg2':
      _setLegPassedOff(0, '#00e676');
      _setLegPassedOff(1, '#00e676');
      // rtn_leg2 has started — message is flying home. Dismiss the lag banner.
      _closeRelayLagPopup();
      // 22s comet — bumped from 15s so the cyan dot is easier to catch.
      _startComet(0, true, '#29b6f6', 22, function(){ _relayAnimComplete(anim); });
      break;
    case 'timeout':
      _stopCometAnims();
      _setLegPassedOff(0, '#ff9800');
      if(_chainLegs[1]) _chainLegs[1].setStyle({color:'#ff9800', opacity:0.5, dashArray:'8 6'});
      _showRelayBreakdownPopup(anim);
      break;
    // C.18: destination did not respond within 45s — offer Switch Path
    case 'timeout_dest':
      _stopCometAnims();
      _setLegPassedOff(0, '#ff9800');
      if(_chainLegs[1]) _chainLegs[1].setStyle({color:'#ff9800', opacity:0.5, dashArray:'8 6'});
      _closeRelayLagPopup();
      _showSwitchPathPanel(anim);
      break;
    // Return-leg failure: target replied to the via, but the via never relayed
    // it back to us. Same remedy as timeout_dest — offer ranked Switch Path.
    case 'timeout_return':
      _stopCometAnims();
      _setLegPassedOff(0, '#00e676');   // outbound legs succeeded
      if(_chainLegs[1]) _chainLegs[1].setStyle({color:'#ff9800', opacity:0.5, dashArray:'8 6'});
      _closeRelayLagPopup();
      _showSwitchPathPanel(anim);
      break;
  }
}

function _relayAnimComplete(anim) {
  _stopCometAnims();
  _hideSwitchPathPanel();
  _chainLegs.forEach(function(l){ if(l) l.setStyle({color:'#00e676', opacity:1.0}); });
  var via = (anim && anim.via) || _chainVia || '?';
  _kbToast('✓ Relay complete via ' + via + ' — ACK received', 5000);
  setTimeout(function(){
    _chainLegs.forEach(function(l){ if(l) l.setStyle({color:'#00e676', opacity:0.65}); });
  }, 3000);
}

// ── C.18: Switch Path panel ───────────────────────────────────────────────────
function _showSwitchPathPanel(anim) {
  _hideSwitchPathPanel();
  var via = (anim && anim.via) || _chainVia || '?';
  var tgt = (anim && anim.target) || _chainTarget || '?';
  fetch('/relay_yes_list.json').then(function(r){ return r.json(); })
  .then(function(data) {
    var panel = document.createElement('div');
    panel.id  = 'switch-path-panel';
    var ageMin = Math.round((data.age_s || 0) / 60);
    var ageStr = ageMin < 1 ? 'just now' : ageMin + 'm ago';
    var staleHtml = data.stale
      ? '<div class="sp-stale">⚠ Path data ' + ageStr
        + ' — consider re-querying</div>'
      : '<div class="sp-age">Path data from ' + ageStr + '</div>';
    var failed = data.failed_vias || [];
    var yesList = (data.yes_list || []).slice()
      .sort(function(a,b){ return (b.snr||0)-(a.snr||0); });
    var rows = '';
    yesList.forEach(function(entry) {
      var isFailed = failed.indexOf(entry.via) >= 0 || entry.via === via;
      var failedCls = isFailed ? ' sp-failed' : '';
      var snrStr = (entry.snr !== null && entry.snr !== undefined)
        ? (entry.snr >= 0 ? '+' : '') + Math.round(entry.snr) : '?';
      var onclick = isFailed ? ''
        : ' data-via="' + entry.via + '" onclick="_switchPathTo(this.dataset.via)"';
      rows += '<div class="sp-row' + failedCls + '"' + onclick + '>'
            + '<span class="sp-call">' + entry.via + '</span>'
            + '<span class="sp-snr">SNR ' + snrStr + '</span>'
            + '</div>';
    });
    if(!rows) rows = '<div style="font-size:12px;font-weight:700;color:#ff6b6b;'
                   + 'background:rgba(200,0,0,0.15);border-radius:6px;'
                   + 'padding:8px 10px;margin:6px 0;text-align:center;">'
                   + '❌ No alternate paths — Relay Failed</div>';
    panel.innerHTML =
      '<h3>⚠ ' + tgt + ' not responding via ' + via + '</h3>'
      + staleHtml + rows
      + '<div class="sp-btns">'
      + '<button class="sp-btn sp-btn-abandon" onclick="_hideSwitchPathPanel();clearChain()">'
      + '✕ Abandon</button>'
      + '</div>';
    document.getElementById('map').appendChild(panel);
  }).catch(function(){
    // Fallback: show simple abandon panel if fetch fails
    var panel = document.createElement('div');
    panel.id = 'switch-path-panel';
    panel.innerHTML = '<h3>⚠ ' + tgt + ' not responding via ' + via + '</h3>'
      + '<div class="sp-btns">'
      + '<button class="sp-btn sp-btn-abandon" onclick="_hideSwitchPathPanel();clearChain()">'
      + '✕ Abandon</button></div>';
    document.getElementById('map').appendChild(panel);
  });
}

function _hideSwitchPathPanel() {
  var p = document.getElementById('switch-path-panel');
  if(p) p.remove();
}

// ── C.18: Relay outcome sticky bar ───────────────────────────────────────────
var _lastOutcomeStatus = null;  // track last rendered status to avoid flicker
var _lastOutcomeData   = null;  // store full outcome for Switch Path handoff
var _dismissedOutcome  = '';    // status+ts the operator closed; the 1 s poll
                                // must not bring it back before the server's
                                // clear lands (2026-10-18a)
function _outcomeKey(o){ return o ? (o.status + '|' + (o.ts || '') + '|' + (o.target || '')) : ''; }

function _updateOutcomeBar(outcome) {
  if(!outcome) {
    var bar = document.getElementById('relay-outcome-bar');
    if(bar) bar.remove();
    _lastOutcomeStatus = null;
    _lastOutcomeData   = null;
    return;
  }
  if(_outcomeKey(outcome) === _dismissedOutcome) return;   // closed by the operator
  if(outcome.status === _lastOutcomeStatus) return;
  _lastOutcomeStatus = outcome.status;
  _lastOutcomeData   = outcome;

  var bar = document.getElementById('relay-outcome-bar');
  if(!bar) {
    bar = document.createElement('div');
    bar.id = 'relay-outcome-bar';
    document.body.appendChild(bar);
  }

  var ts   = outcome.ts ? new Date(outcome.ts * 1000) : new Date();
  var hhmm = ts.getHours().toString().padStart(2,'0') + ':'
           + ts.getMinutes().toString().padStart(2,'0');
  var via  = outcome.via    || '?';
  var tgt  = outcome.target || '?';

  if(outcome.status === 'complete') {
    bar.className = 'outcome-complete';
    bar.innerHTML =
      '<span class="ob-msg">✓ Relay complete · '
      + tgt + ' via ' + via + ' · ' + hhmm + '</span>'
      + '<span class="ob-actions">'
      + '<button class="ob-close" onclick="_dismissOutcomeBar()" title="Close">×</button>'
      + '</span>';
  } else {
    var msg;
    if(outcome.status === 'failed_dest') {
      msg = '⚠ ' + tgt + ' not responding via ' + via + ' · ' + hhmm;
    } else if(outcome.status === 'failed_return') {
      msg = '⚠ ' + via + ' got ' + tgt + '\u2019s reply but didn\u2019t relay it back · ' + hhmm;
    } else {
      msg = '⚠ Relay timeout · ' + tgt + ' via ' + via + ' · ' + hhmm;
    }
    bar.className = 'outcome-failed';
    bar.innerHTML =
      '<span class="ob-msg">' + msg + '</span>'
      + '<span class="ob-actions">'
      + '<button class="ob-btn" onclick="_outcomeBarSwitchPath()">Switch Path</button>'
      + '<button class="ob-close" onclick="_dismissOutcomeBar()" title="Close">×</button>'
      + '</span>';
  }
}

function _outcomeBarSwitchPath() {
  // Opens Switch Path panel using stored outcome data — avoids inline quote escaping.
  // Keep the data first: _dismissOutcomeBar() clears it, so the panel never
  // opened. (2026-10-18a)
  var data = _lastOutcomeData;
  _dismissOutcomeBar();
  if(data) _showSwitchPathPanel(data);
}

function _dismissOutcomeBar() {
  _dismissedOutcome = _outcomeKey(_lastOutcomeData);
  var bar = document.getElementById('relay-outcome-bar');
  if(bar) bar.remove();
  _lastOutcomeStatus = null;
  _lastOutcomeData   = null;
  fetch('/relay_outcome_clear', {method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({})}).catch(function(){});
}

function _switchPathTo(newVia) {
  _hideSwitchPathPanel();
  fetch('/relay_switch_path', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({via: newVia})
  }).then(function(r){ return r.json(); })
  .then(function(data) {
    if(!data.ok) return;
    // Update chain state to new via
    _chainVia = newVia;
    _chainMsgPrefix = data.clipboard || (newVia+'>'+data.target+' ');
    _chainCommitted = false;   // allows GO to re-fire
    _relayAnimState = null;    // reset so new state triggers fresh animation
    // Copy new prefix to clipboard
    _copyToClipboard(_chainMsgPrefix);
    // Redraw the path legs with new via
    _clearChainLegs();
    _drawChainLegs();
    applyFilters();
    // Re-commit for the new via, then open the compose popup (consistent w/ GO)
    _chainCommitted = true;
    fetch('/relay_commit', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({via: newVia, target: data.target, msg:''})
    }).catch(function(){});
    const _nv = newVia, _nt = data.target;
    openComposePopup({
      title: 'Relay via ' + _nv + ' \u2192 ' + _nt,
      prefixLabel: _nv + '>' + _nt,
      call: _nv,
      buildFrame: function(t){ return (_nv + '>' + _nt + ' ' + t).trim(); },
      statusEl: null
    });
  }).catch(function(){
    _kbToast('⚠ Switch Path failed — try again');
  });
  // Dismiss the failed outcome pill and refresh banner to show new via selected
  _dismissOutcomeBar();
  if(_relayTarget) applyRelayFilter(_relayTarget);
}

function clearChain(){
  _stopCometAnims();
  _relayAnimState = null;
  _chainVia=null; _chainCommitted=false;
  _clearChainLegs();
  _userHasMoved = true;   // prevent auto-fit on auto-refresh cycle
  _relayTarget='';
  _restoreRelayLines();
  _hideSwitchPathPanel();
  const rb=$('relay-banner'); if(rb) rb.remove();
  const rs=$('relay-search'); if(rs) rs.value='';
  const rc=$('relay-clear');  if(rc) rc.style.display='none';
  applyFilters();
  fetch('/relay_arm_clear',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({})}).catch(()=>{});
  fetch('/relay_active',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({active:false})}).catch(()=>{});
  // Explicitly fit all stations after returning from relay view
  setTimeout(function(){ _userHasMoved=false; fitAll(); }, 600);
  _kbToast('Back to full map');
}
function toggleFitExclusion(call, btn){
  const wasExcluded = btn.dataset.excluded === 'true';
  const nowExcluded = !wasExcluded;
  if(nowExcluded) FIT_EXCLUSIONS.add(call); else FIT_EXCLUSIONS.delete(call);
  btn.dataset.excluded = String(nowExcluded);
  btn.textContent = '📐 Fit';
  btn.title = nowExcluded
    ? 'Click to include this station in the Fit All view again'
    : 'Remove this station from the Fit All view';
  btn.style.color       = nowExcluded ? '#e84060' : 'rgba(255,255,255,0.7)';
  btn.style.borderColor = nowExcluded ? '#e84060' : 'rgba(255,255,255,0.7)';
  fetch('/set_fit_exclusion',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({call,excluded:nowExcluded})}).catch(()=>{});
  _kbToast(nowExcluded ? `📐 ${call} excluded from Fit` : `📐 ${call} restored to Fit`);
}



/* ── Dark custom tooltips (match JS8FastChat) ───────────────────────────────
   The map previously relied on native HTML title="" tooltips, which the
   browser renders with a white background / black text — inconsistent with
   JS8FastChat's dark tooltips, and slow/unreliable to appear (that's why the
   Compact button's tip seemed not to show). This lightweight engine replaces
   them globally: it moves each element's title into data-tip (so the native
   one never fires) and shows a single dark-styled floating div on hover.
   No per-button markup changes needed; any element with a title is covered,
   including popup content injected later (we resolve titles on mouseover).   */
(function(){
  var tipEl = null;
  var hideTimer = null;

  function ensureTip(){
    if(tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.id = 'js8-custom-tip';
    tipEl.style.cssText =
      'position:fixed;z-index:100000;pointer-events:none;'+
      'background:#1b2430;color:#e8eaed;'+
      'border:1px solid rgba(255,255,255,0.18);border-radius:6px;'+
      'padding:5px 9px;font-family:var(--font-main),Arial,sans-serif;'+
      'font-size:13px;font-weight:600;line-height:1.35;'+
      'max-width:340px;box-shadow:0 4px 14px rgba(0,0,0,0.45);'+
      'opacity:0;transition:opacity .12s;white-space:normal;';
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function getTitleFrom(node){
    // Walk up a few levels so hovering an icon inside a titled button works.
    var hops = 0;
    while(node && node !== document.body && hops < 4){
      if(node.nodeType === 1 && node.getAttribute){
        // A live title attr wins and is (re)migrated to data-tip -- this lets
        // code that sets el.title later (e.g. the Fit toggle) update the tip.
        var t = node.getAttribute('title');
        if(t){
          node.setAttribute('data-tip', t);
          node.removeAttribute('title');   // suppress the native tooltip
          return {node:node, text:t};
        }
        var dt = node.getAttribute('data-tip');
        if(dt) return {node:node, text:dt};
      }
      node = node.parentNode; hops++;
    }
    return null;
  }

  function show(text, x, y){
    var el = ensureTip();
    el.textContent = text;
    el.style.opacity = '1';
    position(x, y);
  }
  function position(x, y){
    if(!tipEl) return;
    var pad = 14;
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var vx = window.innerWidth, vy = window.innerHeight;
    var left = x + pad, top = y + pad + 4;
    if(left + w + 4 > vx) left = x - w - pad;          // flip left near right edge
    if(top + h + 4 > vy) top = y - h - pad;            // flip up near bottom edge
    if(left < 2) left = 2;
    if(top < 2) top = 2;
    tipEl.style.left = left + 'px';
    tipEl.style.top  = top  + 'px';
  }
  function hide(){
    if(tipEl) tipEl.style.opacity = '0';
  }

  document.addEventListener('mouseover', function(e){
    var found = getTitleFrom(e.target);
    if(found){
      if(hideTimer){ clearTimeout(hideTimer); hideTimer = null; }
      show(found.text, e.clientX, e.clientY);
    }
  });
  document.addEventListener('mousemove', function(e){
    if(tipEl && tipEl.style.opacity === '1') position(e.clientX, e.clientY);
  });
  document.addEventListener('mouseout', function(e){
    // Hide when leaving a titled element (small delay avoids flicker between
    // child nodes of the same button).
    if(hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 60);
  });
  // Hide on any click/scroll so it never lingers over a changing popup.
  document.addEventListener('click', hide, true);
  document.addEventListener('scroll', hide, true);
})();


/* ══════════════════════════════════════════════════════════════════════════
   CommStat StatReps
   ──────────────────────────────────────────────────────────────────────────
   Data: /statrep.json, built by js8map_statrep.py from its own database --
   fed live from JS8Call AND imported from JS8Spotter's js8spotter.db. It is
   independent of /data.json, so QSY / Clear Map never hides a report.

   On the map: one diamond per reporting station (its LATEST report), colored
   by the Map Pin status the sender chose. A red corner flag means some other
   category is worse than the pin. Dashed outline = approximate position (the
   report had no usable grid, so the last heard grid or FCC address is used).

   Board (top-left, under zoom): alerts, then stations worst-first, each with
   its 12-category strip. Click a row to fly there and open the report.
   ══════════════════════════════════════════════════════════════════════════ */
const SR_PAGE_BUILD = '2026-10-29e';   // keep in step with STATREP_BUILD in js8map_statrep.py
const SR_COLORS = {'1':'#28a745','2':'#ffc107','3':'#dc3545','4':'#6c757d','6':'#8e44ad','7':'#d63384'};
const SR_NAMES  = {'1':'Green','2':'Yellow','3':'Red','4':'Unknown','6':'Event','7':'Attack'};
const SR_RANK   = {'3':4,'7':4,'2':3,'6':3,'4':1,'1':0};
const SR_ALERT  = {1:['#e8e800','#000'],2:['#ff8c00','#fff'],3:['#dc3545','#fff'],4:['#000','#fff']};
const SR_CATS   = ['Map Pin','Power','Water','Medical','Comms','Travel','Internet','Fuel','Food','Crime','Civil','Weather'];
const SR_CATS_SHORT = ['PIN','PWR','H2O','MED','COM','TRV','NET','FUEL','FOOD','CRM','CIV','WX'];

function _srSS(k, d){ try{ const v = SS.getItem(k); return v === null ? d : v; }catch(e){ return d; } }
function _srSSet(k, v){ try{ SS.setItem(k, v); }catch(e){} }

let _srOn      = _srSS('sr_on', 'true') !== 'false';
let _mfOn      = _srSS('mf_on', 'true') !== 'false';   // MCForms squares layer (14o)
// Time-window choices for the StatRep box and the table tabs (14n). Default
// 1 h; a remembered choice that is no longer on the list falls back to 1 h.
const SR_WINDOWS = [[1,'Last 1 h'],[2,'Last 2 h'],[4,'Last 4 h'],[8,'Last 8 h'],
                    [12,'Last 12 h'],[24,'Last 24 h'],[48,'Last 2 days']];
let _srHours   = +_srSS('sr_hours', '1') || 1;
if(!SR_WINDOWS.some(w => w[0] === _srHours)) _srHours = 1;
let _srOpen    = _srSS('sr_board', 'open') !== 'closed';
let _srKeyOpen = _srSS('sr_key', 'false') === 'true';
let _srIncOpen = _srSS('sr_inc_open', 'true') !== 'false';
let _srData    = null;
let _srRev     = -1;
let _srKnownIds   = null;            // report ids seen so far (null = first load)
let _srKnownAlerts= null;
const _srMarkers = {};               // base call -> L.marker
map.createPane('statrepPane');
map.getPane('statrepPane').style.zIndex = 640;   // above station dots, below popups
const _srLayer = L.layerGroup().addTo(map);

function _srAge(min){
  if(min === null || min === undefined) return '';
  if(min < 1)   return 'just now';
  if(min < 60)  return min + 'm ago';
  if(min < 2880) return Math.floor(min/60) + 'h ' + (min%60 ? (min%60)+'m ' : '') + 'ago';
  return Math.floor(min/1440) + 'd ago';
}
function _srTopSev(r){ return (SR_RANK[r.worst]||0) > (SR_RANK[r.overall]||0) ? r.worst : r.overall; }
function _srSummary(r){
  const bad = [];
  for(let i=1;i<12;i++){ const d=r.status[i]; if(d==='2'||d==='3'||d==='6'||d==='7') bad.push(SR_CATS[i]+' '+SR_NAMES[d]); }
  if(!bad.length){
    const unk = r.status.slice(1).split('').filter(d=>d==='4').length;
    return unk ? ('All OK · '+unk+' unknown') : 'All Green';
  }
  return bad.join(' · ');
}

// True when the live station layer already labels this call -- then the
// diamond needs no call tag of its own (it would sit on top of that label).
function _srHasLive(base){
  if(window.SR_ONLY) return false;          // station labels are hidden in CommStat Only
  try{ return LAYERS.some(l => l && l.call && l.call.split('/')[0].toUpperCase() === base); }
  catch(e){ return false; }
}
function _srIcon(r, fresh){
  const col  = SR_COLORS[r.overall] || SR_COLORS['4'];
  const flag = (SR_RANK[r.worst]||0) > (SR_RANK[r.overall]||0) ? SR_COLORS[r.worst] : '';
  const html = '<div class="sr-pin'+(r.approx?' sr-approx':'')+(fresh?' sr-fresh':'')+'">'
    + '<div class="sr-dia" style="background:'+col+'"></div>'
    + (flag ? '<div class="sr-flag" style="background:'+flag+'"></div>' : '')
    + (_srHasLive(r.base) ? '' : '<div class="sr-tag">'+_esc(r.call)+'</div>') + '</div>';
  return L.divIcon({className:'sr-icon', html:html, iconSize:[22,22], iconAnchor:[11,11], popupAnchor:[0,-12]});
}

function _srStrip(status, big){
  let h = '<div class="sr-strip'+(big?' sr-strip-big':'')+'">';
  for(let i=0;i<12;i++){
    const d = status[i];
    h += '<span class="sr-cell" style="background:'+(SR_COLORS[d]||'#444')+'" title="'
      + SR_CATS[i]+': '+(SR_NAMES[d]||d)+'">'+(big?SR_CATS_SHORT[i]:'')+'</span>';
  }
  return h + '</div>';
}

function _srPopupHtml(r){
  const top = _srTopSev(r);
  const col = SR_COLORS[top] || SR_COLORS['4'];
  const fg  = top === '2' ? '#000' : '#fff';
  const safe = r.call.replace('/','_');
  let h = '<div class="p-inner sr-pop">'
    + '<div class="p-call">'+_esc(r.call)+' <span class="sr-srid">StatRep '+_esc(r.sr_id)+'</span></div>'
    + '<div class="p-badge" style="background:'+col+';color:'+fg+'">'+_esc(_srSummary(r))+'</div>'
    + _srStrip(r.status, true);
  if(r.remarks || r.partial) h += '<div class="sr-remarks">'+_esc(r.remarks)+(r.partial ? ' …'+' <span class="sr-part" title="The end of this report was lost on the air — remarks are cut short. Grid, ID and status decoded fine.">incomplete</span>' : '')+'</div>';
  h += '<table class="p-table">'
    + '<tr><td>Sent to</td><td>'+_esc(r.to||'—')+'</td></tr>'
    + '<tr><td>Scope</td><td>'+_esc(r.scope_name||'—')+'</td></tr>'
    + '<tr><td>Grid</td><td>'+_esc(r.grid || (r.plot_grid
          ? r.plot_grid + (r.approx ? ' · FCC address, approx' : ' · last heard grid')
          : 'none sent'))+'</td></tr>'
    + '<tr><td>Received</td><td>'+_esc(r.rx_time)+' UTC · '+_srAge(r.age_min)+'</td></tr>'
    + '<tr><td>Heard via</td><td>'+_esc(r.sources.join(' + '))+(r.internet?' · internet copy':'')+'</td></tr>';
  if(r.freq) h += '<tr><td>Freq / SNR</td><td>'+(r.freq/1e6).toFixed(3)+' MHz'+(r.snr!==null&&r.snr!==undefined?' · '+(r.snr>0?'+':'')+r.snr+' dB':'')+'</td></tr>';
  if(r.relay || r.forwarded) h += '<tr><td>Forwarded</td><td>'+(r.relay?'by '+_esc(r.relay):'yes')+'</td></tr>';
  h += '<tr><td>Acked by</td><td>'+(r.acks.length ? r.acks.map(a=>_esc(a.by)).join(', ') : '—')+'</td></tr>'
    + '</table>';
  if(r.history && r.history.length){
    h += '<div class="p-divider"></div><div class="p-section-hdr">Earlier reports</div><div class="sr-hist">';
    r.history.forEach(function(x){
      const c = SR_COLORS[x.overall]||SR_COLORS['4'];
      h += '<span class="sr-hdot" style="background:'+c+'" title="'+_esc(x.sr_id+' · '+x.rx_time+' UTC · '+(SR_NAMES[x.overall]||x.overall))+'"></span>';
    });
    h += '</div>';
  }
  h += '<div class="sr-pop-btns">'
    + '<button class="map-toggle-btn" onclick="openInFastChat(event,\''+_esc(r.call)+'\')" title="Open this station in JS8FastChat">⚡ FastChat</button>'
    + '<button class="map-toggle-btn" onclick="zoomToCallsign(\''+_esc(r.call)+'\')" title="Find this station\'s live dot">🔍 Station</button>'
    + '</div><div id="js8-status-'+_esc(safe)+'" class="sr-pop-status"></div></div>';
  return h;
}

// StatRep diamonds on the map, after the header group filter (2026-10-19b):
// with Groups: @X on, a report shows only when it was sent to @X or its
// sender is an @X member -- the same rule as the tables and the dots, so a
// diamond / square never sits on the map without its station. (Operator,
// Windows: @GHOSTNET hid KF7MIX's dot but left its F!104 square and line.)
function _srReportsShown(){
  const all = (_srData && _srData.reports) || [];
  const gf = (typeof _grpRowFilter === 'function') ? _grpRowFilter() : null;
  return gf ? all.filter(r => gf(r.call, r.to)) : all;
}
function _srRenderMarkers(){
  const keep = {};
  if(_srOn && _srData && window.SR_VIEW !== 'mcf' && window.SR_VIEW !== 'qso'){   // diamonds: CommStat layer
    _srReportsShown().forEach(function(r){
      keep[r.base] = true;
      const fresh = _srKnownIds && !_srKnownIds.has(r.id);
      let m = _srMarkers[r.base];
      const live = _srHasLive(r.base);
      if(m && m._srId === r.id && m._srLat === r.lat && m._srLon === r.lon){
        m._sr = r;
        if(m._srLive !== live){ m._srLive = live; m.setIcon(_srIcon(r, false)); }
        if(!m.isPopupOpen()) m.setPopupContent(_srPopupHtml(r));
        return;
      }
      if(m){ _srLayer.removeLayer(m); }
      m = L.marker([r.lat, r.lon], {icon:_srIcon(r, fresh), pane:'statrepPane', riseOnHover:true});
      m._srId = r.id; m._srLat = r.lat; m._srLon = r.lon; m._sr = r; m._srLive = live;
      m.bindPopup(_srPopupHtml(r), {maxWidth:380, minWidth:320, autoPanPadding:[40,40]});
      m.bindTooltip(function(){ const x=m._sr; return _esc(x.call+' · '+x.sr_id+' · '+_srSummary(x)+' · '+_srAge(x.age_min)); },
                    {direction:'top', offset:[0,-12], opacity:0.95});
      m.addTo(_srLayer);
      _srMarkers[r.base] = m;
    });
  }
  Object.keys(_srMarkers).forEach(function(k){
    if(!keep[k]){ _srLayer.removeLayer(_srMarkers[k]); delete _srMarkers[k]; }
  });
  _srRenderLines();
  if(_srData && typeof _mfRenderMarkers === 'function') _mfRenderMarkers();   // MCForms squares
}

/* Lines from each StatRep / MCForms site to my station.
   Only views (14r): one line per site of that kind, colored by status/series.
   Normal view (17b): StatRep diamonds and MCForms squares get a line too,
   thinner and fainter -- EXCEPT when that station's own heard dot sits at
   the same spot (within ~10 km), because its station line already shows it.
   A report whose grid differs from where the station is plotted (e.g. FCC
   address vs reported grid) therefore always gets its own line.
   Solid = grid sent in the report, dashed = approximate position. */
const _srLineLayer = L.layerGroup().addTo(map);
const _SR_LINE_SKIP_M = 10000;      // a station dot this close covers the site
function _srStationNear(call, ll){
  const base = String(call || '').split('/')[0].toUpperCase();
  for (const l of LAYERS) {
    if (String(l.call || '').split('/')[0].toUpperCase() !== base) continue;
    if (!map.hasLayer(l.marker)) continue;
    const p = l.marker.getLatLng();
    if (p && map.distance(p, ll) < _SR_LINE_SKIP_M) return true;
  }
  return false;
}
function _srRenderLines(){
  _srLineLayer.clearLayers();
  if(window.SR_VIEW === 'qso' || !_srData || MY_LAT === undefined) return;
  const home = L.latLng(MY_LAT, MY_LON);
  const only = !!window.SR_ONLY;
  let sites = [];
  const mcf = () => _mfLatest().map(f => ({lat:f.lat, lon:f.lon, call:f.call, approx:f.approx,
                                            _col:_mfSeries(f.form_id)[0]}));
  if (only) {
    sites = window.SR_VIEW === 'mcf' ? mcf() : _srReportsShown();
  } else {
    if (_srOn) sites = sites.concat(_srReportsShown());
    if (_mfOn) sites = sites.concat(mcf());
  }
  sites.forEach(function(r){
    if (r.lat === undefined || r.lon === undefined) return;
    const ll = L.latLng(r.lat, r.lon);
    const mi = Math.round(map.distance(home, ll) / 1609.344);
    if(mi < 1) return;
    if(!only && _srStationNear(r.call, ll)) return;
    const col = r._col || SR_COLORS[_srTopSev(r)] || SR_COLORS['4'];
    L.polyline([ll, home], {color: col, weight: only ? 2 : 1.5, opacity: only ? 0.6 : 0.45,
                            pane: 'statrepPane', dashArray: r.approx ? '5 6' : null, interactive: true})
      .bindTooltip(_esc(r.call) + ' → ' + _esc(MY_CALL) + ' · ' + mi + ' mi', {sticky: true})
      .addTo(_srLineLayer);
  });
}

/* ── Board (Leaflet control) ── */
/* Docked bottom-right, directly above the Legend tab. When the legend panel
   is open the board rides up to sit on top of it (_srPlace). It lives
   outside the map container, so map clicks / wheel never pass through it. */
(function(){
  const d = document.createElement('div');
  d.className = 'sr-board';
  d.id = 'sr-board';
  document.body.appendChild(d);
})();
function _srPlace(){
  const el = $('sr-board'), leg = $('legend');
  if(!el) return;
  const legOpen = leg && leg.style.display !== 'none';
  const bottom = legOpen ? (42 + leg.offsetHeight + 8) : 46;
  el.style.bottom = bottom + 'px';
  const body = el.querySelector('.sr-body');
  if(body) body.style.maxHeight = Math.max(120, window.innerHeight - bottom - 290) + 'px';
  // Never taller than the space below the filter bar: header + footer stay,
  // the ? key and the report list scroll inside (14s -- key used to run up
  // under the toolbar).
  const mapEl = $('map');
  const topLimit = (mapEl ? mapEl.getBoundingClientRect().top : 100) + 8;
  el.style.maxHeight = Math.max(200, window.innerHeight - bottom - topLimit) + 'px';
}
window.addEventListener('resize', _srPlace);

function _srRenderBoard(){
  const el = $('sr-board');
  if(!el) return;
  const _bShowSR = _srOn && window.SR_VIEW !== 'mcf' && window.SR_VIEW !== 'qso';
  const _bShowMF = _mfOn && window.SR_VIEW !== 'commstat' && window.SR_VIEW !== 'qso';
  el.style.display = (_srOn || _mfOn) && window.SR_VIEW !== 'qso' ? '' : 'none';
  if(el.style.display === 'none') return;
  const D = _srData || {reports:[], unplotted:[], alerts:[], spotter:{}};
  const all = D.reports.concat(D.unplotted);
  const n = {'1':0,'2':0,'3':0,'4':0};
  all.forEach(r => { const t=_srTopSev(r); n[t==='7'?'3':t==='6'?'2':t] = (n[t==='7'?'3':t==='6'?'2':t]||0)+1; });
  el.classList.toggle('sr-min', !_srOpen);
  let h = '<div class="sr-head" onclick="_srToggleBoard()" title="'+(_srOpen?'Minimize':'Expand')+' the StatRep board">'
    + '<span class="sr-title">📋 StatReps</span>'
    + '<span class="sr-counts" title="Stations by their worst category: Red · Yellow · Green · Unknown">'
    + '<span class="sr-cnt"><i style="background:'+SR_COLORS['3']+'"></i>'+n['3']+'</span>'
    + '<span class="sr-cnt"><i style="background:'+SR_COLORS['2']+'"></i>'+n['2']+'</span>'
    + '<span class="sr-cnt"><i style="background:'+SR_COLORS['1']+'"></i>'+n['1']+'</span>'
    + '<span class="sr-cnt"><i style="background:'+SR_COLORS['4']+'"></i>'+n['4']+'</span></span>'
    + (D.alerts && D.alerts.length ? '<span class="sr-alert-chip">⚠ '+D.alerts.length+'</span>' : '')
    + (_srOpen ? '<button class="sr-minbtn'+(_srKeyOpen?' sr-keyon':'')+'" onclick="event.stopPropagation();_srToggleKey()" title="What the colors mean">?</button>' : '')
    + '<button class="sr-minbtn" onclick="event.stopPropagation();_srToggleBoard()" title="'
    + (_srOpen?'Minimize':'Expand')+'">'+(_srOpen?'−':'+')+'</button></div>';
  if(_srOpen){
    if(_srKeyOpen) h += _srKeyHtml();
    h += '<div class="sr-body">';
    (D.alerts||[]).slice(0,5).forEach(function(a){
      const c = SR_ALERT[a.color] || SR_ALERT[4];
      h += '<div class="sr-alert" style="border-left-color:'+c[0]+'" title="'+_esc(a.message)+'">'
        + '<div class="sr-alert-top"><span class="sr-alert-pill" style="background:'+c[0]+';color:'+c[1]+'">'+_esc(a.color_name)+'</span> '
        + '<b>'+_esc(a.title)+'</b></div>'
        + '<div class="sr-alert-msg">'+_esc(a.message)+'</div>'
        + '<div class="sr-meta">'+_esc(a.call)+' → '+_esc(a.to)+' · '+_esc(a.rx_time.slice(5,16))+' UTC</div></div>';
    });
    if(!all.length && !(D.forms||[]).length){
      h += '<div class="sr-empty">No StatReps or MCForms in this window.<br>'
        + 'Reports appear here as JS8Call decodes them'
        + (D.spotter && D.spotter.enabled ? ' or JS8Spotter logs them.' : '.<br>Link JS8Spotter from <b>📋 StatReps…</b> in JS8Map.')
        + '</div>';
    }
    (_bShowSR ? all : []).forEach(function(r){      // StatRep rows only when that layer shows
      const plotted = r.lat !== undefined;
      const col = SR_COLORS[r.overall]||SR_COLORS['4'];
      h += '<div class="sr-row'+(plotted?'':' sr-noloc')+'" onclick="_srGoto(\''+_esc(r.base)+'\')" title="'
        + _esc(_srSummary(r)+(r.remarks?' — '+r.remarks:''))+'">'
        + '<span class="sr-rdia" style="background:'+col+'"></span>'
        + '<span class="sr-rcall">'+_esc(r.call)+'</span>'
        + '<span class="sr-rid">'+_esc(r.sr_id)+(r.acks.length ? ' <span class="sr-tack" title="Acked by '+_esc(r.acks.map(a=>a.by).join(', '))+'">✓'+r.acks.length+'</span>' : '')+'</span>'
        + '<span class="sr-rage">'+(plotted?'':'📍? ')+_srAge(r.age_min)+'</span>'
        + _srStrip(r.status, false)
        + ((r.remarks || r.partial) ? '<div class="sr-rrem">'+_esc(r.remarks)+(r.partial ? ' …'+' <span class="sr-part" title="The end of this report was lost on the air — remarks are cut short. Grid, ID and status decoded fine.">incomplete</span>' : '')+'</div>' : '')
        + '</div>';
    });
    if(_srData && typeof _mfBoardHtml === 'function' && _bShowMF) h += _mfBoardHtml(D);
    h += _srIncompleteHtml(D, 'board');
    const sp = D.spotter || {};
    h += '</div><div class="sr-foot">'
      + '<select class="map-dropdown sr-win" onchange="_srSetHours(+this.value)" title="How far back to show StatReps">'
      + SR_WINDOWS
          .map(o=>'<option value="'+o[0]+'"'+(o[0]===_srHours?' selected':'')+'>'+o[1]+'</option>').join('')
      + '</select>'
      + '<button class="map-toggle-btn sr-imp" onclick="toggleStatRepTable(true)" title="CommStat-style table of every report">📊 Table</button>'
      + (sp.path && sp.enabled ? '<button class="map-toggle-btn sr-imp" onclick="_srImportNow(this)" title="'+_esc('JS8Spotter: '+(sp.status||''))+'">⟳ Spotter</button>' : '')
      + '</div>'
      + '<div class="sr-spot">'+(sp.path && sp.enabled ? 'JS8Spotter: '+_esc(sp.status||'') : 'Live from JS8Call')
      + ' · <span title="StatRep page build / server build">build '+SR_PAGE_BUILD+(D.build && D.build !== SR_PAGE_BUILD ? ' ⚠ server '+_esc(D.build) : '')+'</span></div>';
  }
  el.innerHTML = h;
  _srPlace();
}
function _srToggleBoard(){ _srOpen = !_srOpen; _srSSet('sr_board', _srOpen?'open':'closed'); _srRenderBoard(); }
function _srSetHours(h){ _srHours = h; _srSSet('sr_hours', String(h)); _srRev = -1; _srPoll();
  if(typeof _qsoPoll === 'function') _qsoPoll(); }          // QSO badges / lines follow the window too
// 'last 1 h' / 'last 2 days' -- the dropdown's own wording, for headings
function _srWinLabel(){ const w = SR_WINDOWS.find(x => x[0] === _srHours); return (w ? w[1] : 'Last ' + _srHours + ' h').toLowerCase(); }
function _srImportNow(btn){
  if(btn){ btn.disabled = true; btn.textContent = '⟳ Reading…'; }
  fetch('/statrep_import', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'})
    .catch(function(){}).finally(function(){ setTimeout(_srPoll, 1500); setTimeout(_srPoll, 5000); });
}
function _srGoto(base){
  const m = _srMarkers[base];
  if(m){
    _beginProgrammaticFit();
    map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 7), {duration:0.8});
    setTimeout(function(){ m.openPopup(); }, 850);
    return;
  }
  const r = (_srData && _srData.unplotted || []).find(x => x.base === base);
  if(r) L.popup({maxWidth:380, minWidth:320}).setLatLng(map.getCenter()).setContent(
          _srPopupHtml(r) + '<div class="sr-pop-status" style="padding:0 16px 12px">No grid in this report and no position on file — shown at map centre.</div>'
        ).openOn(map);
}
function toggleStatReps(){
  _srOn = !_srOn;
  if(!_srOn && window.SR_VIEW === 'commstat') _srSetView('');   // CommStat Only needs the layer
  _srSSet('sr_on', _srOn ? 'true' : 'false');
  _srApplyBtn();
  _srRenderMarkers();
  _srRenderBoard();
}
function _srApplyBtn(){
  const b = $('statrep-btn');
  if(b){ b.textContent = _srOn ? '✓ Show' : 'Show'; b.classList.toggle('show-on', _srOn); }
}

let _srLastFull = 0;
function _srPoll(){
  // Send the last rev so an unchanged store answers {unchanged:true} and
  // nothing is rebuilt. A full refresh still happens at least once a minute
  // so the "Nm ago" ages and 15-minute dimming keep moving.
  const fresh = _srRev !== -1 && (Date.now() - _srLastFull) < 60000;
  fetch('/statrep.json?hours=' + _srHours + (fresh ? '&rev=' + encodeURIComponent(_srRev) : '')
        + '&_=' + Date.now())
    .then(r => r.ok ? r.json() : null)
    .then(function(d){
      if(!d || d.error || d.unchanged || !d.reports) return;
      _srLastFull = Date.now();
      const prevIds = _srKnownIds;
      _srData = d;
      _srRenderMarkers();
      _srRenderBoard();
      if(typeof _srRenderTable === 'function') _srRenderTable();
      // Announce what is NEW since the page loaded (not the backlog).
      const ids = new Set(d.reports.concat(d.unplotted).map(r => r.id));
      const aids = new Set((d.alerts||[]).map(a => a.id));
      if(prevIds){
        d.reports.concat(d.unplotted).filter(r => !prevIds.has(r.id)).slice(0,1).forEach(function(r){
          _kbToast('📋 StatRep ' + r.sr_id + ' from ' + r.call + ' · ' + _srSummary(r), 4000);
        });
        (d.alerts||[]).filter(a => !_srKnownAlerts.has(a.id)).slice(0,1).forEach(function(a){
          _kbToast('⚠ ' + a.color_name.toUpperCase() + ' ALERT · ' + a.call + ' · ' + a.title, 6000);
        });
        if(_mfKnownIds) (d.forms||[]).filter(f => !_mfKnownIds.has(f.id)).slice(0,1).forEach(function(f){
          _kbToast('📝 ' + f.form_id + ' ' + (f.title||'') + ' from ' + f.call, 4500);
        });
      }
      _mfKnownIds = new Set((d.forms||[]).map(f => f.id));
      _srKnownIds = ids; _srKnownAlerts = aids; _srRev = d.rev;
    })
    .catch(function(){});
}
_srApplyBtn();
_srRenderBoard();
_srPoll();
setInterval(_srPoll, 15000);


/* ══════════════════════════════════════════════════════════════════════════
   StatRep TABLE view  (CommStat-style)
   One row per report, 12 colored status columns. "Issues only" hides
   all-green reports. Clicking a callsign switches back to the map and flies
   to that licensee's FCC-database address (/fcc_locate.json), with a dashed
   line to the grid the report itself gave when the two are far apart.
   ══════════════════════════════════════════════════════════════════════════ */
let _srTblOn     = false;
let _srTblIssues = _srSS('sr_tbl_issues', 'false') === 'true';
let _srTblGroup  = '';
let _srTblFind   = '';
let _srTblSort   = {key:'rx_time', dir:-1};
const _srFccLayer = L.layerGroup().addTo(map);

(function(){
  const d = document.createElement('div');
  d.id = 'sr-table-view';
  d.style.display = 'none';
  document.body.appendChild(d);
})();

function _srGridLL(g){
  g = (g||'').toUpperCase();
  if(!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
  let lon = (g.charCodeAt(0)-65)*20 - 180 + (+g[2])*2;
  let lat = (g.charCodeAt(1)-65)*10 - 90 + (+g[3]);
  if(g.length === 6){ lon += (g.charCodeAt(4)-65)*(2/24) + 1/24; lat += (g.charCodeAt(5)-65)/24 + 1/48; }
  else { lon += 1; lat += 0.5; }
  return [lat, lon];
}
function _srLocal(ts){           // stored UTC 'YYYY-MM-DD HH:MM:SS' -> 'Oct-09 15:18' local
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if(isNaN(d)) return ts;
  const m = d.toLocaleString('en-US', {month:'short'});
  return m + '-' + String(d.getDate()).padStart(2,'0') + ' '
       + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
function _srIsIssue(r){ return r.status.split('').some(d => d !== '1'); }

function _srTableRows(){
  let rows = (_srData && _srData.rows) ? _srData.rows.slice() : [];
  if(_srTblIssues) rows = rows.filter(_srIsIssue);
  if(_srTblGroup)  rows = rows.filter(r => r.to === _srTblGroup);
  if(_srTblFind)   rows = rows.filter(r => r.call.indexOf(_srTblFind) >= 0);
  const _gf = _grpRowFilter(); if(_gf) rows = rows.filter(r => _gf(r.call, r.to));
  const k = _srTblSort.key, dir = _srTblSort.dir;
  rows.sort(function(a, b){
    let va, vb;
    if(k === 'sev'){ va = SR_RANK[_srTopSev(a)]||0; vb = SR_RANK[_srTopSev(b)]||0; }
    else if(k.startsWith('c')){ const i = +k.slice(1); va = SR_RANK[a.status[i]]||0; vb = SR_RANK[b.status[i]]||0; }
    else { va = a[k] === undefined ? '' : a[k]; vb = b[k] === undefined ? '' : b[k]; }
    if(va < vb) return -dir; if(va > vb) return dir;
    return a.rx_time < b.rx_time ? 1 : -1;
  });
  return rows;
}

function _srRenderTable(){
  const el = $('sr-table-view');
  if(!el || !_srTblOn) return;
  if(_srTblTab !== 'statrep') return _mfRenderTab(el);      // MCForms / Traffic / Reference
  const all = (_srData && _srData.rows) || [];
  const rows = _srTableRows();
  const groups = Array.from(new Set(all.map(r => r.to).filter(Boolean))).sort();
  const issues = all.filter(_srIsIssue).length;
  const th = (key, label, extra) => '<th class="'+(extra||'')+(_srTblSort.key===key?' sr-sorted':'')+'" onclick="_srSortBy(\''+key+'\')">'
           + label + (_srTblSort.key===key ? (_srTblSort.dir<0?' ▾':' ▴') : '') + '</th>';
  let h = '<div class="sr-tbar">'
    + _srTabsHtml() + _grpChip()
    + '<label class="sr-tchk"><input type="checkbox" '+(_srTblIssues?'checked':'')+' onchange="_srSetIssues(this.checked)"> Issues only <b>('+issues+')</b></label>'
    + '<select class="map-dropdown" onchange="_srTblGroup=this.value;_srRenderTable()"><option value="">All groups</option>'
    + groups.map(g => '<option'+(g===_srTblGroup?' selected':'')+'>'+_esc(g)+'</option>').join('') + '</select>'
    + '<select class="map-dropdown" onchange="_srSetHours(+this.value)" title="How far back">'
    + SR_WINDOWS
        .map(o=>'<option value="'+o[0]+'"'+(o[0]===_srHours?' selected':'')+'>'+o[1]+'</option>').join('') + '</select>'
    + '<input class="search sr-tfind" placeholder="🔍 Callsign…" value="'+_esc(_srTblFind)+'" '
    + 'oninput="this.value=this.value.toUpperCase();_srTblFind=this.value;_srRenderTable()">'
    + '</div><div class="sr-twrap"><table class="sr-table"><thead><tr>'
    + th('sev','', 'sr-tsev') + th('rx_time','Date Time') + th('freq','Freq') + th('call','From') + th('to','To')
    + th('sr_id','ID') + th('grid','Grid') + th('scope','Scope');
  SR_CATS_SHORT.forEach(function(lbl, i){ h += th('c'+i, i===0?'Map':lbl, 'sr-tcat'); });
  h += th('remarks','Remarks','sr-trem') + th('sources','Via') + '</tr></thead><tbody>';
  if(!rows.length){
    h += '<tr><td colspan="21" class="sr-tempty">'
      + (all.length ? 'No reports match these filters.' : 'No StatReps in this window yet.') + '</td></tr>';
  }
  rows.forEach(function(r){
    const sev = SR_COLORS[_srTopSev(r)] || SR_COLORS['4'];
    h += '<tr>'
      + '<td class="sr-tsev" style="background:'+sev+'"></td>'
      + '<td title="'+_esc(r.rx_time)+' UTC">'+_esc(_srLocal(r.rx_time))+'</td>'
      + '<td>'+(r.freq ? (r.freq/1e6).toFixed(3) : '—')+'</td>'
      + '<td><a class="sr-tcall" href="#" onclick="_srLocate(\''+_esc(r.call)+'\','+r.id+');return false;" '
      +   'title="Show '+_esc(r.call)+' on the map at the FCC address">'+_esc(r.call)+'</a></td>'
      + '<td>'+_esc(r.to)+'</td>'
      + '<td>'+_esc(r.sr_id)+(r.acks.length?' <span class="sr-tack" title="Acked by '+_esc(r.acks.map(a=>a.by).join(', '))+'">✓'+r.acks.length+'</span>':'')+'</td>'
      + '<td class="sr-tmono">'+_esc(r.grid||'—')+'</td>'
      + '<td>'+_esc((r.scope_name||'').toUpperCase())+'</td>';
    for(let i=0;i<12;i++){
      const d = r.status[i];
      h += '<td class="sr-tcell" style="background:'+(SR_COLORS[d]||'#444')+'" title="'+SR_CATS[i]+': '+(SR_NAMES[d]||d)+'">'
        + (d==='1' ? '' : (d==='4' ? '?' : '!')) + '</td>';
    }
    h += '<td class="sr-trem">'+_esc(r.remarks)+(r.partial ? ' …'+' <span class="sr-part" title="The end of this report was lost on the air — remarks are cut short. Grid, ID and status decoded fine.">incomplete</span>' : '')+'</td>'
      + '<td class="sr-tvia">'+_esc(r.sources.map(s => s==='JS8Spotter'?'Spotter':'Live').join('+'))+'</td></tr>';
  });
  h += '</tbody></table>' + _srIncompleteHtml(_srData || {}, 'table') + '</div>';
  const sc = el.querySelector('.sr-twrap');
  const keep = sc ? sc.scrollTop : 0;
  const typing = document.activeElement && document.activeElement.classList.contains('sr-tfind');
  el.innerHTML = h;
  if(typing){ const f = el.querySelector('.sr-tfind'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  const sc2 = el.querySelector('.sr-twrap'); if(sc2) sc2.scrollTop = keep;
}
function _srSortBy(k){
  if(_srTblSort.key === k) _srTblSort.dir *= -1;
  else _srTblSort = {key:k, dir: (k==='call'||k==='to'||k==='sr_id'||k==='grid'||k==='remarks') ? 1 : -1};
  _srRenderTable();
}
function _srSetIssues(v){ _srTblIssues = v; _srSSet('sr_tbl_issues', v?'true':'false'); _srRenderTable(); }

function _srPlaceTable(){
  const el = $('sr-table-view'), m = $('map');
  if(el && m) el.style.top = m.getBoundingClientRect().top + 'px';
}
window.addEventListener('resize', _srPlaceTable);

function toggleStatRepTable(on){
  const wasOn = _srTblOn;
  _srTblOn = (on === undefined) ? !_srTblOn : !!on;
  if(_srTblOn && !wasOn && _srTblTab === 'traffic') _trEnterTab();   // opening onto Traffic
  const el = $('sr-table-view');
  _srPlaceTable();
  el.style.display = _srTblOn ? 'flex' : 'none';
  const b = $('statrep-table-btn');
  if(b){ b.textContent = _srTblOn ? '🗺 Map View' : '📊 StatRep Table'; b.classList.toggle('sr-btn-on', _srTblOn); }
  const rb = $('return-map-btn'); if(rb) rb.hidden = !_srTblOn;          // header Return to Map
  if(_srTblOn) _srRenderTable(); else setTimeout(function(){ map.invalidateSize(); }, 50);
}
document.addEventListener('keydown', function(e){
  if(_srTblOn && (e.key === 'Escape')){ e.stopPropagation(); toggleStatRepTable(false); }
}, true);

/* Callsign click: back to the map, fly to the FCC address. */
function _srLocate(call, rowId, note){
  const row = ((_srData && _srData.rows) || []).find(r => r.id === rowId) || null;
  toggleStatRepTable(false);
  _srFccLayer.clearLayers();
  fetch('/fcc_locate.json?call=' + encodeURIComponent(call) + '&_=' + Date.now())
    .then(r => r.ok ? r.json() : {found:false})
    .catch(() => ({found:false}))
    .then(function(f){
      const repLL = row ? _srGridLL(row.grid || row.plot_grid) : null;
      let ll, head;
      if(f && f.found){
        ll = [f.lat, f.lon];
        const prec = f.precision === 'heard' ? 'Not in FCC database — last grid heard (' + (f.grid||'') + ')'
                   : f.precision === 'address' ? 'FCC address'
                   : f.precision === 'zip' ? 'FCC ZIP code area (approx.)' : 'FCC state centre (approx.)';
        head = '<div class="sr-fcc"><div class="sr-fcc-name">'+_esc(f.name||call)+'</div>'
             + '<div class="sr-fcc-loc">'+_esc([f.city, f.state].filter(Boolean).join(', '))
             + (f.class ? ' · '+_esc(f.class) : '')+'</div>'
             + '<div class="sr-fcc-src">📍 '+prec+'</div></div>';
      } else if(repLL){
        ll = repLL;
        head = '<div class="sr-fcc"><div class="sr-fcc-src">⚠ '+_esc(call)+' not found in the FCC database'
             + (f && f.fcc_db === false ? ' (no FCC DB installed — use ⬇ Update FCC DB)' : '')
             + ' — showing the grid from the report.</div></div>';
      } else {
        _kbToast('⚠ ' + call + ': not in the FCC database' + (row ? ' and the report has no grid' : ''), 3500);
        return;
      }
      const icon = L.divIcon({className:'sr-icon', html:'<div class="sr-fccpin">📍</div>',
                              iconSize:[28,28], iconAnchor:[14,26], popupAnchor:[0,-24]});
      const mk = L.marker(ll, {icon:icon, pane:'statrepPane', zIndexOffset:1000}).addTo(_srFccLayer);
      if(f && f.found && repLL && map.distance(L.latLng(ll), L.latLng(repLL)) > 15000){
        L.polyline([ll, repLL], {color:'#ffc107', weight:2, dashArray:'6 6', opacity:.85, pane:'statrepPane'})
          .bindTooltip('Report grid ' + _esc(row.grid || row.plot_grid) + ' · ' + Math.round(map.distance(L.latLng(ll), L.latLng(repLL))/1609) + ' mi from FCC address')
          .addTo(_srFccLayer);
      }
      mk.bindPopup(head + (row ? _srPopupHtml(row) : '<div class="p-inner"><div class="p-call">'+_esc(call)+'</div>'
                   + (note ? '<div class="sr-remarks">'+_esc(note)+'</div>' : '')
                   + '<div class="sr-pop-btns"><button class="map-toggle-btn" onclick="openInFastChat(event,\''+_esc(call)+'\')">⚡ FastChat</button></div>'
                   + '<div id="js8-status-'+_esc(call.replace('/','_'))+'" class="sr-pop-status"></div></div>'),
                   {maxWidth:380, minWidth:320, autoPanPadding:[40,40]});
      mk.on('popupclose', function(){ setTimeout(function(){ if(!mk.isPopupOpen()) _srFccLayer.clearLayers(); }, 60000); });
      _beginProgrammaticFit();
      map.flyTo(ll, Math.max(map.getZoom(), 8), {duration:0.9});
      setTimeout(function(){ mk.openPopup(); }, 1000);
    });
}

/* ── Heard but incomplete ─────────────────────────────────────────────────
   (a) RRSR acks for StatReps this station never decoded -- someone else
   copied a report from that call; (b) group messages whose frames were lost
   ('……'). Matched per station so a lost message followed by an ack reads
   as "report lost on air". Click to see the station at its FCC address
   (and ask for a repeat: "<CALL> AGN?"). */
function _srToggleInc(){ _srIncOpen = !_srIncOpen; _srSSet('sr_inc_open', _srIncOpen?'true':'false'); _srRenderBoard(); _srRenderTable(); }
function _srIncNote(x){
  if(x.kind === 'acked'){
    const by = x.acks.map(a => a.by).join(', ');
    return (x.lost_at ? 'StatRep ' + x.sr_id + ' lost on the air here at ' + _srLocal(x.lost_at).slice(7)
                      : 'StatRep ' + x.sr_id + ' not heard here')
         + ' — acked by ' + by + '. Ask for a repeat: ' + x.call + ' AGN?';
  }
  return x.times.length + ' message' + (x.times.length===1?'':'s') + ' to ' + (x.to||'the group')
       + ' lost on the air (' + x.times.map(t => _srLocal(t).slice(7)).join(', ') + ').';
}
function _srIncompleteHtml(D, where){
  const inc = (D && D.incomplete) || [];
  if(!inc.length) return '';
  let h = '<div class="sr-inc sr-inc-'+where+'"><div class="sr-inc-head" onclick="_srToggleInc()" '
        + 'title="Reports and messages heard only in part — click a station to see it on the map">'
        + '⚠ Heard but incomplete <b>('+inc.length+')</b><span class="sr-inc-caret">'+(_srIncOpen?'▾':'▸')+'</span></div>';
  if(_srIncOpen){
    inc.forEach(function(x){
      const note = _srIncNote(x);
      const tag = x.kind === 'acked' ? '<span class="sr-inc-tag sr-inc-acked">'+_esc(x.sr_id)+' ✓'+x.acks.length+'</span>'
                                     : '<span class="sr-inc-tag">lost ×'+x.times.length+'</span>';
      h += '<div class="sr-inc-row" onclick="_srLocate(\''+_esc(x.call)+'\',-1,\''+_esc(note).replace(/'/g,"&#39;")+'\')" title="'+_esc(note)+'">'
         + '<span class="sr-inc-call">'+_esc(x.call)+'</span>'+tag
         + '<span class="sr-inc-time">'+_esc(_srLocal(x.ts).slice(7))+'</span>'
         + '<div class="sr-inc-note">'+_esc(note)+'</div></div>';
    });
  }
  return h + '</div>';
}

/* ── Color key (the "?" button on the StatRep board) ── */
function _srToggleKey(){ _srKeyOpen = !_srKeyOpen; _srSSet('sr_key', _srKeyOpen?'true':'false'); _srRenderBoard(); }
function _srKeyHtml(){
  const sw = (c, t, d) => '<div class="sr-key-row"><i style="background:'+c+'"></i><b>'+t+'</b><span>'+d+'</span></div>';
  let cells = '';
  SR_CATS_SHORT.forEach(function(s, i){ cells += '<span title="'+SR_CATS[i]+'">'+(i===0?'PIN':s)+'</span>'; });
  return '<div class="sr-key">'
    + '<div class="sr-key-h">Status colors</div>'
    + sw(SR_COLORS['1'], 'Green', 'Normal / OK')
    + sw(SR_COLORS['2'], 'Yellow', 'Degraded — some problems')
    + sw(SR_COLORS['3'], 'Red', 'Serious problem / not available')
    + sw(SR_COLORS['4'], 'Gray', 'Unknown — not reported')
    + '<div class="sr-key-note">The four numbers in the header count <b>stations</b> by their worst category, in that order: red · yellow · green · gray.</div>'
    + '<div class="sr-key-h">12-cell strip (left → right)</div>'
    + '<div class="sr-key-cells">'+cells+'</div>'
    + '<div class="sr-key-note">Map Pin, Power, Water, Medical, Comms, Travel, Internet, Fuel, Food, Crime, Civil, Weather. Hover a cell for its name.</div>'
    + '<div class="sr-key-h">On the map</div>'
    + '<div class="sr-key-row"><i class="sr-key-dia" style="background:'+SR_COLORS['1']+'"></i><b>Diamond</b><span>The station\'s latest StatRep, in the Map Pin color it chose</span></div>'
    + '<div class="sr-key-row"><i class="sr-key-dot" style="background:'+SR_COLORS['3']+'"></i><b>Corner dot</b><span>Another category is worse than the pin</span></div>'
    + '<div class="sr-key-row"><i class="sr-key-dia sr-key-dash"></i><b>Dashed</b><span>Approximate position — no grid in the report (last heard grid or FCC address)</span></div>'
    + '<div class="sr-key-row"><i class="sr-key-sq"></i><b>Square</b><span>MCForms report, numbered by form (dashed = no grid in the form)</span></div>'
    + '<div class="sr-key-h">Lines to my station</div>'
    + '<div class="sr-key-row"><i class="sr-key-line"></i><b>Solid</b><span>Position from the grid sent in the report</span></div>'
    + '<div class="sr-key-row"><i class="sr-key-line sr-key-line-d"></i><b>Dashed</b><span>Approximate — no grid sent, placed at the sender\'s last heard grid or FCC address</span></div>'
    + '<div class="sr-key-note">Line color = the report\'s worst status (CommStat) or the form\'s color (MCForms). Hover a line for the distance.</div>'
    + '<div class="sr-key-h">Tags</div>'
    + '<div class="sr-key-row"><span class="sr-tack sr-key-tag">✓2</span><span>Acked (RRSR) by 2 stations</span></div>'
    + '<div class="sr-key-row"><span class="sr-part sr-key-tag">incomplete</span><span>End of report lost on the air; remarks cut short</span></div>'
    + '<div class="sr-key-row"><span class="sr-inc-tag sr-key-tag">lost ×3</span><span>Messages from that station not decoded</span></div>'
    + '</div>';
}

/* ── CommStat Only view ──────────────────────────────────────────────────
   Hides the regular station dots, labels and heard/hearing lines so only
   the StatRep sites (plus my own station) remain, then zooms to fit them.
   Remembered for the session. Turning it off restores every filter as it was. */
/* ── CommStat Only / MCForms Only views (MCForms Only added 2026-10-14c) ──
   SR_VIEW: '' (normal) | 'commstat' (StatRep diamonds only) | 'mcf' (MCForms
   squares only). SR_ONLY = any of the two -- applyFilters hides the regular
   station dots, labels and lines whenever it is true. The two are exclusive. */
window.SR_VIEW = (function(){ const v = _srSS('sr_view', ''); if(v) return v;
  return _srSS('sr_only', 'false') === 'true' ? 'commstat' : ''; })();   // pre-14c setting
window.SR_ONLY = !!window.SR_VIEW;
function _srSetView(v){
  window.SR_VIEW = v || '';
  window.SR_ONLY = !!window.SR_VIEW;
  _srSSet('sr_view', window.SR_VIEW); _srSSet('sr_only', window.SR_ONLY ? 'true' : 'false');
  if(window.SR_VIEW === 'commstat' && !_srOn){ _srOn = true; _srSSet('sr_on', 'true'); _srApplyBtn(); }
  if(window.SR_VIEW === 'mcf' && !_mfOn){ _mfOn = true; _srSSet('mf_on', 'true'); _mfApplyBtn(); }
  if(window.SR_VIEW === 'qso' && !_qsoOn){ _qsoOn = true; _srSSet('qso_on', 'true'); _qsoApplyBtn(); _qsoPoll(); }
  _srApplyOnlyBtn();
  applyFilters();
  _srRenderMarkers();                       // diamonds / squares / call tags / lines
  _srRenderBoard();
  if(typeof _qsoRender === 'function') _qsoRender();   // badges follow the stations shown
  if(window.SR_ONLY) _srFitSites();
  else if(typeof fitAll === 'function') setTimeout(fitAll, 150);   // back to normal: Fit All view
}
function toggleCommStatOnly(on){
  const want = (on === undefined) ? window.SR_VIEW !== 'commstat' : !!on;
  _srSetView(want ? 'commstat' : (window.SR_VIEW === 'commstat' ? '' : window.SR_VIEW));
}
function toggleMcfOnly(on){
  const want = (on === undefined) ? window.SR_VIEW !== 'mcf' : !!on;
  _srSetView(want ? 'mcf' : (window.SR_VIEW === 'mcf' ? '' : window.SR_VIEW));
}
function toggleQsoOnly(on){
  const want = (on === undefined) ? window.SR_VIEW !== 'qso' : !!on;
  _srSetView(want ? 'qso' : (window.SR_VIEW === 'qso' ? '' : window.SR_VIEW));
}
function _srApplyOnlyBtn(){
  [['commstat-only-btn','commstat'],['mcf-only-btn','mcf'],['qso-only-btn','qso']].forEach(function(x){
    const b = $(x[0]); const on = window.SR_VIEW === x[1];
    if(b){ b.textContent = on ? 'Only ✓' : 'Only'; b.classList.toggle('only-on', on); }
  });
  document.body.classList.toggle('sr-only-mode', window.SR_VIEW === 'commstat');
  document.body.classList.toggle('mf-only-mode', window.SR_VIEW === 'mcf');
  document.body.classList.toggle('qso-only-mode', window.SR_VIEW === 'qso');
}
function _srFitSites(){
  let pts;
  if(window.SR_VIEW === 'qso'){
    pts = LAYERS.filter(l => l && l.marker && map.hasLayer(l.marker) && l.call !== MY_CALL).map(l => l.marker.getLatLng());
  } else {
    pts = (window.SR_VIEW === 'mcf' ? [] : Object.values(_srMarkers))
      .concat(window.SR_VIEW === 'commstat' ? [] : Object.values(_mfMarkers)).map(m => m.getLatLng());
  }
  if(!pts.length){ _kbToast(window.SR_VIEW === 'mcf' ? '📝 No MCForms sites in this window yet'
                          : window.SR_VIEW === 'qso' ? '💬 No QSOs in the last hour'
                                                     : '📋 No StatRep sites in this window yet', 2500); return; }
  _beginProgrammaticFit();
  if(pts.length === 1) map.flyTo(pts[0], Math.max(map.getZoom(), 7), {duration:0.8});
  else map.flyToBounds(L.latLngBounds(pts).pad(0.25), {duration:0.8, maxZoom:8});
}
_srApplyOnlyBtn();
if(window.SR_ONLY){ applyFilters(); setTimeout(_srFitSites, 1500); }


/* ══════════════════════════════════════════════════════════════════════════
   MCForms reports + tagged traffic + reference          (build 2026-10-14a)
   ──────────────────────────────────────────────────────────────────────────
   Data rides in /statrep.json:
     forms    -- MCForms reports ('F!309 ...'), decoded server-side against
                 the form files (js8map_forms.py), newest first
     traffic  -- every directed message heard, one tag each
   /mcforms.json (fetched once, for the Reference tab) has every form's
   questions, answer codes and fields.

   On the map: a small square per station per form (its latest copy), in
   the form series color. Dashed = the form had no grid, so it sits at the
   sender's own position. Amber ring = something did not decode cleanly.
   Shown with the StatRep layer (📋 StatReps On).
   ══════════════════════════════════════════════════════════════════════════ */
const MF_SERIES = {'1':['#17a2b8','Station / net'],'3':['#fd7e14','Situation'],
                   '5':['#8e44ad','Area assessment'],'7':['#2979ff','Group forms']};
const TR_FAM = {commstat:['#e0a000','CommStat'], mcforms:['#2979ff','MCForms'],
                qso:['#14b8a6','QSO'], query:['#8e44ad','Queries'], js8:['#607d8b','JS8Call'], text:['#6c757d','Text']};
function _mfSeries(fid){ return MF_SERIES[(fid||'').charAt(2)] || ['#6c757d','Other']; }
function _mfNum(fid){ return (fid||'').replace('F!',''); }
// The '#XXXX' time code is when the sender FILLED IN the form. JS8Spotter
// re-sends a stored form unchanged, so it can be much older than when heard.
function _mfStale(f){
  if(!f.sent || !f.rx_time) return '';
  const d = (new Date(f.rx_time.replace(' ','T')+'Z') - new Date(f.sent.replace(' ','T')+'Z')) / 86400000;
  if(!(d >= 1)) return '';
  const n = Math.round(d);
  return ' <span class="mf-stale" title="When the sender filled in this form. It was heard '+n+' day'+(n===1?'':'s')+' later — likely a stored form being re-sent.">· '+n+' day'+(n===1?'':'s')+' before heard</span>';
}
// 'Maidenhead Grid Square (REQUIRED - 4, 6, 8, or 10 characters)' -> 'Maidenhead Grid Square'
function _mfShort(label){
  let t = String(label||'').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if(t.length > 48) t = t.slice(0, 46).replace(/\s+\S*$/, '') + '…';
  return t || String(label||'');
}

let _mfOpenRows = new Set();          // expanded rows in the MCForms table
let _mfTblForm = '', _mfTblFind = '';
let _trFam = {commstat:true, mcforms:true, qso:true, query:true, js8:true, text:true};
let _trTag = '', _trFind = '';

/* Click-to-sort headers for the MCForms and Traffic tabs (17g), same look
   and behaviour as the StatReps tab: click a header to sort by it, click
   again to reverse; ▾/▴ marks the sorted column. The sort survives the
   15 s refresh and the filters; a page reload goes back to newest first.
   Text columns start A→Z, times and numbers start highest first. Blank
   values always sort last. Ties fall back to newest first. */
const _tblSort = {forms: {key:'rx_time', dir:-1}, traffic: {key:'rx_time', dir:-1}};
const _TBL_TEXT_KEYS = new Set(['call','to','form_id','title','grid','summary','sources','tag','text','family','series']);
function _tblTh(tab, key, label, extra){
  const st = _tblSort[tab], on = st.key === key;
  return '<th class="'+(extra||'')+(on?' sr-sorted':'')+'" onclick="_tblSortBy(\''+tab+'\',\''+key+'\')" title="Sort by '+(label||'colour')+'">'
       + label + (on ? (st.dir<0?' ▾':' ▴') : '') + '</th>';
}
function _tblSortBy(tab, key){
  const st = _tblSort[tab];
  if(st.key === key) st.dir *= -1;
  else { st.key = key; st.dir = _TBL_TEXT_KEYS.has(key) ? 1 : -1; }
  _srRenderTable();
}
// rows: array; tab: 'forms' | 'traffic'; val(row, key) -> sortable value
function _tblSortRows(rows, tab, val){
  const k = _tblSort[tab].key, dir = _tblSort[tab].dir;
  const blank = v => v === null || v === undefined || v === '';
  return rows.slice().sort(function(a, b){
    let va = val(a, k), vb = val(b, k);
    const ba = blank(va), bb = blank(vb);
    if(ba !== bb) return ba ? 1 : -1;                     // blanks last, either direction
    if(!ba){
      if(typeof va === 'string' || typeof vb === 'string'){
        const c = String(va).localeCompare(String(vb), undefined, {numeric:true, sensitivity:'base'});
        if(c) return c * dir;
      } else if(va !== vb) return (va < vb ? -1 : 1) * dir;
    }
    return a.rx_time < b.rx_time ? 1 : (a.rx_time > b.rx_time ? -1 : 0);
  });
}
function _mfSortVal(f, k){
  if(k === 'summary') return _mfSummary(f);
  if(k === 'sources') return (f.sources||[]).join('+');
  if(k === 'title')   return f.title || 'Unknown form';
  if(k === 'series')  return _mfSeries(f.form_id)[0] + ' ' + f.form_id;   // colour, then form
  return f[k];
}
function _trSortVal(t, k){
  if(k === 'tag')    return _trLabel(t.tag);
  if(k === 'family') return (TR_FAM[t.family] ? TR_FAM[t.family][1] : t.family);
  return t[k];
}
let _mfCatalog = null;                 // /mcforms.json, loaded on first Reference view
let _mfRefFind = '';
let _srTblTab = _srSS('sr_tbl_tab', 'statrep');
let _mfKnownIds = null;

/* ── markers ── */
const _mfMarkers = {};                 // base|form_id -> L.marker
function _mfLatest(){
  const seen = {}, out = [];
  const gf = (typeof _grpRowFilter === 'function') ? _grpRowFilter() : null;   // group filter (2026-10-19b)
  ((_srData && _srData.forms) || []).forEach(function(f){
    const k = f.base + '|' + f.form_id;
    if(seen[k] || f.lat === undefined) return;
    if(gf && !gf(f.call, f.to)) return;
    seen[k] = 1; out.push(f);
  });
  return out;
}
function _mfIcon(f){
  const c = _mfSeries(f.form_id)[0];
  const html = '<div class="mf-pin'+(f.approx?' mf-approx':'')+(f.problems.length?' mf-warn':'')+'" style="background:'+c+'">'
    + _esc(_mfNum(f.form_id)) + '</div>'
    + (_srHasLive(f.base) ? '' : '<div class="sr-tag mf-tag">'+_esc(f.call)+'</div>');
  return L.divIcon({className:'sr-icon', html:html, iconSize:[30,18], iconAnchor:[15,9], popupAnchor:[0,-10]});
}
function _mfSummary(f){
  const ds = (f.fields||[]).find(x => x.code === 'DS' || x.code === 'SU' || x.code === 'IN' || x.code === 'NA');
  if(ds && ds.value) return ds.value;
  const a = (f.answers||[]).filter(x => x.ok).slice(0,2).map(x => x.a);
  return a.join(' · ') || (f.known ? '' : 'unknown form');
}
function _mfDetailHtml(f){
  let h = '';
  if((f.fields||[]).length){
    h += '<table class="p-table mf-ftab">';
    f.fields.forEach(function(x){ h += '<tr><td title="'+_esc(x.label)+'">'+_esc(_mfShort(x.label))+'</td><td><b>'+_esc(x.value||'—')+'</b></td></tr>'; });
    h += '</table>';
  }
  let sec = null;
  if((f.answers||[]).length){
    h += '<div class="mf-ans">';
    f.answers.forEach(function(a){
      if(a.section && a.section !== sec){ sec = a.section; h += '<div class="mf-sec">'+_esc(sec)+'</div>'; }
      h += '<div class="mf-q'+(a.ok?'':' mf-bad')+'"><span class="mf-qt">'+_esc(a.q)+'</span>'
         + '<span class="mf-code">'+_esc(a.code||'–')+'</span><span class="mf-a">'+_esc(a.a)+'</span></div>';
    });
    h += '</div>';
  } else if(!f.known && f.answers_raw){
    h += '<div class="mf-q mf-bad"><span class="mf-qt">Answer codes</span><span class="mf-code">'+_esc(f.answers_raw)+'</span><span class="mf-a">add this form\'s .txt file to decode</span></div>';
  }
  if(f.comment) h += '<div class="sr-remarks">💬 '+_esc(f.comment)+'</div>';
  (f.problems||[]).forEach(function(p){ h += '<div class="mf-prob">⚠ '+_esc(p)+'</div>'; });
  return h;
}
function _mfPopupHtml(f){
  const c = _mfSeries(f.form_id)[0];
  const safe = f.call.replace('/','_');
  let h = '<div class="p-inner sr-pop mf-pop">'
    + '<div class="p-call">'+_esc(f.call)+' <span class="sr-srid">'+_esc(f.form_id)+'</span></div>'
    + '<div class="p-badge" style="background:'+c+';color:#fff">'+_esc(f.title || 'Unknown form '+f.form_id)+'</div>'
    + '<table class="p-table">'
    + '<tr><td>Sent to</td><td>'+_esc(f.to||'—')+(f.relay?' · relayed by '+_esc(f.relay):'')+'</td></tr>'
    + (f.sent ? '<tr><td>Form dated</td><td>'+_esc(f.sent.slice(0,16))+' UTC'+_mfStale(f)+'</td></tr>' : '')
    + '<tr><td>Received</td><td>'+_esc(f.rx_time)+' UTC · '+_srAge(f.age_min)+'</td></tr>'
    + '<tr><td>Position</td><td>'+_esc(f.grid ? f.grid : (f.plot_grid ? f.plot_grid+' · sender\'s location (no grid in form)' : '—'))+'</td></tr>'
    + '<tr><td>Heard via</td><td>'+_esc(f.sources.join(' + '))+(f.freq?' · '+(f.freq/1e6).toFixed(3)+' MHz':'')
    + (f.snr!==null&&f.snr!==undefined?' · '+(f.snr>0?'+':'')+f.snr+' dB':'')+'</td></tr>'
    + '</table><div class="p-divider"></div>' + _mfDetailHtml(f)
    + '<div class="sr-pop-btns">'
    + '<button class="map-toggle-btn" onclick="openInFastChat(event,\''+_esc(f.call)+'\')" title="Open this station in JS8FastChat">⚡ FastChat</button>'
    + '<button class="map-toggle-btn" onclick="zoomToCallsign(\''+_esc(f.call)+'\')" title="Find this station\'s live dot">🔍 Station</button>'
    + '</div><div id="js8-status-'+_esc(safe)+'" class="sr-pop-status"></div></div>';
  return h;
}
function _mfRenderMarkers(){
  const keep = {};
  if(_mfOn && _srData && window.SR_VIEW !== 'commstat' && window.SR_VIEW !== 'qso'){  // squares: MCForms layer
    _mfLatest().forEach(function(f){
      const k = f.base + '|' + f.form_id;
      keep[k] = true;
      let m = _mfMarkers[k];
      if(m && m._mfId === f.id && m._mfLat === f.lat){
        m._mf = f;
        if(!m.isPopupOpen()) m.setPopupContent(_mfPopupHtml(f));
        return;
      }
      if(m) _srLayer.removeLayer(m);
      m = L.marker([f.lat, f.lon], {icon:_mfIcon(f), pane:'statrepPane', riseOnHover:true});
      m._mfId = f.id; m._mfLat = f.lat; m._mf = f;
      m.bindPopup(_mfPopupHtml(f), {maxWidth:420, minWidth:330, autoPanPadding:[40,40]});
      m.bindTooltip(function(){ const x = m._mf; return _esc(x.call+' · '+x.form_id+' '+(x.title||'')+' · '+_srAge(x.age_min)); },
                    {direction:'top', offset:[0,-10], opacity:0.95});
      m.addTo(_srLayer);
      _mfMarkers[k] = m;
    });
  }
  Object.keys(_mfMarkers).forEach(function(k){
    if(!keep[k]){ _srLayer.removeLayer(_mfMarkers[k]); delete _mfMarkers[k]; }
  });
}
function _mfGoto(id){
  const f = ((_srData && _srData.forms) || []).find(x => x.id === id);
  if(!f) return;
  toggleStatRepTable(false);
  const m = _mfMarkers[f.base + '|' + f.form_id];
  if(m && m._mfId === id){
    _beginProgrammaticFit();
    map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 7), {duration:0.8});
    setTimeout(function(){ m.openPopup(); }, 850);
    return;
  }
  const ll = f.lat !== undefined ? [f.lat, f.lon] : map.getCenter();
  L.popup({maxWidth:420, minWidth:330}).setLatLng(ll).setContent(_mfPopupHtml(f)
      + (f.lat === undefined ? '<div class="sr-pop-status" style="padding:0 16px 12px">No grid in this form and no position on file — shown at map centre.</div>' : '')).openOn(map);
}

/* ── StatRep board: latest MCForms ── */
function _mfBoardHtml(D){
  const fs = (D && D.forms) || [];
  if(!fs.length) return '';
  let h = '<div class="mf-board"><div class="mf-board-h">📝 MCForms <b>('+fs.length+')</b>'
        + '<span class="mf-board-more" onclick="event.stopPropagation();_srShowTab(\'forms\')">table ›</span></div>';
  fs.slice(0, 6).forEach(function(f){
    const c = _mfSeries(f.form_id)[0];
    h += '<div class="mf-brow" onclick="_mfGoto('+f.id+')" title="'+_esc((f.title||'')+(f.problems.length?' — '+f.problems.join('; '):''))+'">'
       + '<span class="mf-chip" style="background:'+c+'">'+_esc(_mfNum(f.form_id))+'</span>'
       + '<span class="sr-rcall">'+_esc(f.call)+'</span>'
       + '<span class="sr-rage">'+(f.lat===undefined?'📍? ':'')+(f.problems.length?'⚠ ':'')+_srAge(f.age_min)+'</span>'
       + '<div class="mf-btitle">'+_esc(f.title || 'Unknown form')+(_mfSummary(f) ? ' — '+_esc(_mfSummary(f)) : '')+'</div></div>';
  });
  return h + '</div>';
}

/* ── table tabs ── */
/* Header group filter (Groups: @XXX) applies to the tables too (2026-10-18e).
   A row stays when it was sent TO that group, or when its sender or receiver
   is a station the map counts as a member of it (station.group_all -- heard
   on that group within the station window). Same membership rule as the map
   dots, so the tables and the map agree. */
function _grpNorm(g){ return String(g || '').toUpperCase().replace(/^@/, ''); }
function _grpSel(){ const e = $('group-filter'); return e ? e.value : ''; }
function _grpMembers(g){
  const want = _grpNorm(g), set = new Set();
  LAYERS.forEach(function(l){
    const ga = l && l.station && l.station.group_all;
    if(ga && Object.keys(ga).some(k => _grpNorm(k) === want)) set.add(String(l.call).split('/')[0].toUpperCase());
  });
  return set;
}
// -> filter function (from, to) => bool, or null when no group is selected
function _grpRowFilter(){
  const g = _grpSel(); if(!g) return null;
  const want = _grpNorm(g), mem = _grpMembers(g);
  const b = c => String(c || '').split('/')[0].toUpperCase();
  return function(from, to){
    return (to && String(to).startsWith('@') && _grpNorm(to) === want) || mem.has(b(from)) || mem.has(b(to));
  };
}
function _grpChip(){
  const g = _grpSel(); if(!g) return '';
  return '<button class="grp-chip" onclick="_grpClear()" title="The map\'s group filter is on: only '+_esc(g)
       + ' traffic and its members are listed. Click to turn it off.">👥 '+_esc(g)+' ✕</button>';
}
function _grpClear(){
  const e = $('group-filter'); if(!e) return;
  e.value = '';
  _srRenderTable();                                   // table first: instant
  try { _srRenderMarkers(); } catch(_e){}
  try { e.dispatchEvent(new Event('change')); } catch(_e){}   // then the map
}
// Redraw an open table whenever the header group filter changes. Hooked up
// HERE, not in index.html's onchange: ham_map.html is only re-rendered when
// the map is rebuilt, so after a plain F5 the page kept its old onchange and
// the table waited for the next full refresh (~30-60 s) to drop the filter
// (operator, Linux, 18e). app.js is always fresh. (2026-10-18f)
(function(){
  const e = document.getElementById('group-filter');
  if(e) e.addEventListener('change', function(){
    try { _srRenderTable(); } catch(_e){}
    try { _srRenderMarkers(); } catch(_e){}          // diamonds, squares, lines (2026-10-19b)
  });
})();

function _srTabsHtml(){
  const D = _srData || {};
  const t = (k, label, n) => '<button class="mf-tab'+(_srTblTab===k?' mf-tab-on':'')+'" onclick="_srShowTab(\''+k+'\')">'
          + label + (n !== undefined ? ' <span class="mf-tabn">'+n+'</span>' : '') + '</button>';
  return '<span class="mf-tabs">'
    + t('statrep', '📋 StatReps', (D.rows||[]).length)
    + t('forms', '📝 MCForms', (D.forms||[]).length)
    + t('traffic', '📡 Traffic', (D.traffic||[]).length)
    + t('ref', '📖 Reference') + '</span>';
}
function _srShowTab(k){
  const entering = (k === 'traffic' && _srTblTab !== 'traffic' && _srTblOn);
  _srTblTab = k; _srSSet('sr_tbl_tab', k);
  if(entering) _trEnterTab();                                        // from another tab
  if(!_srTblOn) toggleStatRepTable(true); else _srRenderTable();
}
function _mfHoursSel(){
  return '<select class="map-dropdown" onchange="_srSetHours(+this.value)" title="How far back">'
    + SR_WINDOWS
        .map(o=>'<option value="'+o[0]+'"'+(o[0]===_srHours?' selected':'')+'>'+o[1]+'</option>').join('') + '</select>';
}
function _mfRestoreFocus(el, cls, keep){
  const typing = document.activeElement && document.activeElement.classList.contains(cls);
  return function(){
    if(typing){ const f = el.querySelector('.'+cls); if(f){ f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
    const sc = el.querySelector('.sr-twrap'); if(sc) sc.scrollTop = keep;
  };
}
function _mfRenderTab(el){
  const sc = el.querySelector('.sr-twrap');
  const keep = sc ? sc.scrollTop : 0;
  const after = _mfRestoreFocus(el, 'mf-find', keep);
  el.innerHTML = _srTblTab === 'forms' ? _mfFormsTable()
               : _srTblTab === 'traffic' ? _trTable() : _mfRefView();
  after();
}

/* MCForms table */
function _mfFormsTable(){
  const all = (_srData && _srData.forms) || [];
  const ids = Array.from(new Set(all.map(f => f.form_id))).sort();
  let rows = all.filter(f => (!_mfTblForm || f.form_id === _mfTblForm) && (!_mfTblFind || f.call.indexOf(_mfTblFind) >= 0));
  const _gf = _grpRowFilter(); if(_gf) rows = rows.filter(f => _gf(f.call, f.to));
  rows = _tblSortRows(rows, 'forms', _mfSortVal);
  let h = '<div class="sr-tbar">' + _srTabsHtml() + _grpChip()
    + '<select class="map-dropdown" onchange="_mfTblForm=this.value;_srRenderTable()"><option value="">All forms</option>'
    + ids.map(i => { const f = all.find(x => x.form_id === i); return '<option value="'+i+'"'+(i===_mfTblForm?' selected':'')+'>'+_esc(i+' '+(f.title||''))+'</option>'; }).join('')
    + '</select>' + _mfHoursSel()
    + '<input class="search sr-tfind mf-find" placeholder="🔍 Callsign…" value="'+_esc(_mfTblFind)+'" '
    + 'oninput="this.value=this.value.toUpperCase();_mfTblFind=this.value;_srRenderTable()">'
    + '</div><div class="sr-twrap"><table class="sr-table mf-table"><thead><tr>'
    + _tblTh('forms','series','','sr-tsev') + _tblTh('forms','rx_time','Date Time') + _tblTh('forms','freq','Freq')
    + _tblTh('forms','call','From') + _tblTh('forms','to','To') + _tblTh('forms','form_id','Form') + _tblTh('forms','title','Title')
    + _tblTh('forms','grid','Grid') + _tblTh('forms','summary','Summary','sr-trem') + _tblTh('forms','sources','Via')
    + '</tr></thead><tbody>';
  if(!rows.length) h += '<tr><td colspan="10" class="sr-tempty">'+(all.length ? 'No reports match these filters.'
       : 'No MCForms reports in this window yet. They appear here as JS8Call decodes them — any F! form sent to a group or to you.')+'</td></tr>';
  rows.forEach(function(f){
    const c = _mfSeries(f.form_id)[0];
    const open = _mfOpenRows.has(f.id);
    h += '<tr class="mf-row'+(open?' mf-row-open':'')+'" onclick="_mfToggleRow('+f.id+')" title="Click to '+(open?'hide':'show')+' the decoded form">'
      + '<td class="sr-tsev" style="background:'+c+'"></td>'
      + '<td title="'+_esc(f.rx_time)+' UTC">'+_esc(_srLocal(f.rx_time))+'</td>'
      + '<td>'+(f.freq ? (f.freq/1e6).toFixed(3) : '—')+'</td>'
      + '<td><a class="sr-tcall" href="#" onclick="event.stopPropagation();_mfGoto('+f.id+');return false;" title="Show on the map">'+_esc(f.call)+'</a></td>'
      + '<td>'+_esc(f.to)+'</td>'
      + '<td><span class="mf-chip" style="background:'+c+'">'+_esc(_mfNum(f.form_id))+'</span></td>'
      + '<td>'+_esc(f.title || 'Unknown form')+'</td>'
      + '<td class="sr-tmono">'+_esc(f.grid || '—')+'</td>'
      + '<td class="sr-trem">'+(f.problems.length?'<span class="mf-warnchip" title="'+_esc(f.problems.join('\n'))+'">⚠</span> ':'')+_esc(_mfSummary(f))+'</td>'
      + '<td class="sr-tvia">'+_esc(f.sources.map(s => s==='JS8Spotter'?'Spotter':'Live').join('+'))+'</td></tr>';
    if(open) h += '<tr class="mf-detail"><td></td><td colspan="9"><div class="mf-dwrap">'
      + (f.sent ? '<div class="sr-meta">Form dated '+_esc(f.sent.slice(0,16))+' UTC'+_mfStale(f)+' · raw: <span class="sr-tmono">'+_esc(f.form_id+' '+f.answers_raw)+'</span></div>' : '')
      + _mfDetailHtml(f) + '</div></td></tr>';
  });
  return h + '</tbody></table></div>';
}
function _mfToggleRow(id){ if(_mfOpenRows.has(id)) _mfOpenRows.delete(id); else _mfOpenRows.add(id); _srRenderTable(); }

/* Traffic table */
function _trTable(){
  const all = (_srData && _srData.traffic) || [];
  const tc = (_srData && _srData.tag_counts) || {};
  const tags = Object.keys(tc).sort();
  const _gfT = _grpRowFilter();
  const rows = _tblSortRows(all.filter(t => _trFam[t.family] !== false && (!_trTag || t.tag === _trTag)
                           && (!_trFind || t.call.indexOf(_trFind) >= 0 || (t.to||'').indexOf(_trFind) >= 0)
                           && (!_gfT || _gfT(t.call, t.to))),
                           'traffic', _trSortVal);
  let h = '<div class="sr-tbar">' + _srTabsHtml() + _grpChip();
  // One type at a time (operator request 2026-10-18): ticking a box unticks
  // the others; "All" shows every type again.
  const allOn = Object.keys(TR_FAM).every(k => _trFam[k] !== false);
  h += '<label class="sr-tchk tr-fam" title="Show every type of message"><input type="checkbox" '+(allOn?'checked':'')
     + ' onchange="_trPickFam(\'\')"> All <b>('+all.length+')</b></label>';
  Object.keys(TR_FAM).forEach(function(k){
    const n = all.filter(t => t.family === k).length;
    const on = !allOn && _trFam[k] !== false;
    h += '<label class="sr-tchk tr-fam" title="Show only '+TR_FAM[k][1]+' messages"><input type="checkbox" '+(on?'checked':'')
       + ' onchange="_trPickFam(\''+k+'\')" style="accent-color:'+TR_FAM[k][0]+'"> '+TR_FAM[k][1]+' <b>('+n+')</b></label>';
  });
  h += '<select class="map-dropdown" onchange="_trTag=this.value;_srRenderTable()"><option value="">All tags</option>'
    + tags.map(t => '<option value="'+t+'"'+(t===_trTag?' selected':'')+'>'+_esc(_trLabel(t))+' ('+tc[t]+')</option>').join('') + '</select>'
    + _mfHoursSel()
    + '<input class="search sr-tfind mf-find" placeholder="🔍 Callsign / group…" value="'+_esc(_trFind)+'" '
    + 'oninput="this.value=this.value.toUpperCase();_trFind=this.value;_srRenderTable()">'
    + '</div><div class="sr-twrap"><table class="sr-table tr-table"><thead><tr>'
    + _tblTh('traffic','family','','sr-tsev') + _tblTh('traffic','rx_time','Date Time') + _tblTh('traffic','freq','Freq')
    + _tblTh('traffic','snr','SNR') + _tblTh('traffic','call','From') + _tblTh('traffic','to','To')
    + _tblTh('traffic','tag','Tag') + _tblTh('traffic','text','Message','sr-trem') + '</tr></thead><tbody>';
  if(!rows.length) h += '<tr><td colspan="8" class="sr-tempty">'+(all.length ? 'No messages match these filters.'
       : 'Nothing logged in this window yet. Every directed message JS8Call decodes is listed here with its tag (kept 7 days).')+'</td></tr>';
  rows.forEach(function(t){
    const c = (TR_FAM[t.family]||TR_FAM.text)[0];
    h += '<tr><td class="sr-tsev" style="background:'+c+'"></td>'
      + '<td title="'+_esc(t.rx_time)+' UTC">'+_esc(_srLocal(t.rx_time))+'</td>'
      + '<td>'+(t.freq ? (t.freq/1e6).toFixed(3) : '—')+'</td>'
      + '<td>'+(t.snr!==null&&t.snr!==undefined ? (t.snr>0?'+':'')+t.snr : '—')+'</td>'
      + '<td><a class="sr-tcall" href="#" onclick="_srLocate(\''+_esc(t.call)+'\',-1);return false;" title="Show '+_esc(t.call)+' on the map">'+_esc(t.call)+'</a></td>'
      + '<td>'+_esc(t.to||'')+'</td>'
      + '<td><span class="tr-tag" style="border-color:'+c+';color:'+c+'" onclick="_trTag=\''+t.tag+'\';_srRenderTable()" title="Show only this tag">'+_esc(_trLabel(t.tag))+'</span></td>'
      + '<td class="sr-trem sr-tmono">'+_esc(t.text)+'</td></tr>';
  });
  return h + '</tbody></table></div>';
}
const TR_LABELS = {CS_STATREP:'StatRep', CS_ALERT:'Alert', CS_ACK:'StatRep ack', CS_OTHER:'CommStat other',
  MCF:'MCForm', MCF_REQ:'Form request', EXPECT:'Expect query', LOST:'Frames lost', HEARTBEAT:'Heartbeat',
  HB_REPLY:'Heartbeat reply', CQ:'CQ', SNR:'SNR', GRID:'Grid', INFO:'Info', STATUS:'Status', HEARING:'Hearing',
  MSG:'Stored msg', APRS:'APRS', RELAY:'Relay', ACK:'Ack/RR/73', QUERY:'Query', QSO:'QSO message',
  GARBLE:'Decode garble', TEXT:'Text'};
function _trLabel(t){ return TR_LABELS[t] || t; }
// Pick ONE message type for the Traffic tab ('' = all types). Ticking the box
// that is already the only one ticked goes back to All. The tag dropdown is
// reset, since a tag from another type would leave the table empty.
// Arriving at the Traffic tab from another tab, or opening the table onto
// it, starts at All types / All tags (2026-10-18c). A type picked earlier
// stayed ticked, so coming back later could show an EMPTY table -- e.g.
// CommStat (0) after looking at StatReps. The 💬 QSOs Table button is the
// exception: it opens Traffic on QSO only (_tblQsoMode). A choice made while
// ON the Traffic tab is kept through the 15 s refresh.
function _trEnterTab(){
  if(typeof _tblQsoMode !== 'undefined' && _tblQsoMode) return;
  Object.keys(TR_FAM).forEach(f => { _trFam[f] = true; });
  _trTag = '';
}
function _trPickFam(k){
  const only = k && Object.keys(TR_FAM).every(f => (_trFam[f] !== false) === (f === k));
  Object.keys(TR_FAM).forEach(f => { _trFam[f] = (!k || only) ? true : (f === k); });
  _trTag = '';
  _srRenderTable();
}

/* Reference: what every report and tag means */
function _mfRefView(){
  let h = '<div class="sr-tbar">' + _srTabsHtml()
    + '<input class="search sr-tfind mf-find" placeholder="🔍 Form number or word…" value="'+_esc(_mfRefFind)+'" '
    + 'oninput="_mfRefFind=this.value.toUpperCase();_srRenderTable()">'
    + '<span class="sr-tcount">'+(_mfCatalog ? _mfCatalog.forms.length+' forms loaded' : 'loading…')+'</span>'
    + '</div><div class="sr-twrap"><div class="mf-ref">';
  if(!_mfCatalog){
    fetch('/mcforms.json?_=' + Date.now()).then(r => r.ok ? r.json() : {forms:[]}).catch(() => ({forms:[]}))
      .then(function(d){ _mfCatalog = d; if(_srTblOn && _srTblTab === 'ref') _srRenderTable(); });
  }
  const q = _mfRefFind;
  const hit = s => !q || String(s||'').toUpperCase().indexOf(q) >= 0;
  // CommStat StatRep
  if(hit('STATREP COMMSTAT')){
    h += '<details class="mf-rd" open><summary><span class="mf-chip" style="background:#e0a000">CS</span> CommStat StatRep, Alert &amp; Ack</summary>'
      + '<div class="mf-rbody"><p><b>StatRep</b> <span class="sr-tmono">CALL: @GROUP ,GRID,SCOPE,ID,STATUS,REMARKS,{&amp;%}</span> — twelve status digits, one per category, in this order:</p>'
      + '<div class="mf-cats">' + SR_CATS.map((c,i) => '<span><b>'+(i+1)+'</b> '+c+'</span>').join('') + '</div>'
      + '<p>Each digit: <b style="color:#28a745">1 Green</b> normal · <b style="color:#e0a000">2 Yellow</b> degraded · <b style="color:#dc3545">3 Red</b> serious / not available · <b>4 Unknown</b>. A single <span class="sr-tmono">+</span> means all green. Scope: 1 My QTH · 2 Community · 3 County · 4 Region · 5 Other. '
      + '<span class="sr-tmono">{&amp;%3}</span> = copied over the CommStat internet backbone, <span class="sr-tmono">{F%}</span> = forwarded for another station.</p>'
      + '<p><b>Alert</b> <span class="sr-tmono">CALL: @GROUP ,ID,COLOR,TITLE,MESSAGE,{%%}</span> — color 1 Yellow · 2 Orange · 3 Red · 4 Black.</p>'
      + '<p><b>Ack</b> <span class="sr-tmono">CALL: @GROUP RRSR TARGET,ID</span> — another station confirms it received that StatRep.</p></div></details>';
  }
  if(hit('MCFORMS FORMAT')){
    h += '<details class="mf-rd"><summary><span class="mf-chip" style="background:#2979ff">F!</span> How an MCForms report is sent</summary>'
      + '<div class="mf-rbody"><p>The form file never goes on the air — only <span class="sr-tmono">F!&lt;number&gt; &lt;answers&gt; &lt;fields&gt; &lt;comment&gt; #&lt;time&gt;</span>, e.g. <span class="sr-tmono">F!301 143132111 #ABCD</span>.</p>'
      + '<p>One character per question, in order (look the character up under that question below). Typed fields come back as <span class="sr-tmono">GR[EM79]</span>. '
      + 'The four letters after <span class="sr-tmono">#</span> are the send time: month A–L, day A–Z then 0–4, hour A–X (UTC), minute in 2-minute steps. '
      + '<span class="sr-tmono">E? F!305</span> is a station <i>asking</i> for that form.</p>'
      + '<p>Too few answers usually means the end was lost on the air, or the sender has a different version of the form. To add or update a form, drop its .txt file in <span class="sr-tmono">'+_esc((_mfCatalog&&_mfCatalog.folder)||(_srData&&_srData.forms_folder)||'the forms folder')+'</span> — it is picked up within 30 s.</p></div></details>';
  }
  if(hit('TAGS TRAFFIC')){
    h += '<details class="mf-rd"><summary><span class="mf-chip" style="background:#607d8b">TAG</span> Traffic tags</summary><div class="mf-rbody"><div class="mf-tags">';
    Object.keys(TR_LABELS).forEach(function(k){ h += '<span class="tr-tag">'+_esc(TR_LABELS[k])+'</span>'; });
    h += '</div><p>Every directed message gets one tag. CommStat and MCForms markers in the text win; otherwise JS8Call\'s own command is used (HEARTBEAT, SNR, GRID, MSG …). Messages ending in “?” are Queries.</p></div></details>';
  }
  ((_mfCatalog && _mfCatalog.forms) || []).forEach(function(f){
    const txt = f.id + ' ' + f.title + ' ' + f.questions.map(x => x.q).join(' ') + ' ' + f.prompts.map(x => x.label).join(' ');
    if(!hit(txt)) return;
    const c = _mfSeries(f.id)[0];
    const grid = f.prompts.some(p => p.code === 'GR');
    h += '<details class="mf-rd"'+(q && hit(f.id) ? ' open' : '')+'><summary><span class="mf-chip" style="background:'+c+'">'+_esc(_mfNum(f.id))+'</span> '
      + _esc(f.title)+' <span class="mf-rmeta">'+f.questions.length+' questions · '+f.prompts.length+' fields'+(grid?' · 📍 grid':'')+(f.version?' · ver '+_esc(f.version):'')+'</span></summary><div class="mf-rbody">';
    if(f.prompts.length){
      h += '<div class="mf-sec">Typed fields</div>';
      f.prompts.forEach(p => { h += '<div class="mf-q"><span class="mf-code">'+_esc(p.code)+'[ ]</span><span class="mf-a">'+_esc(p.label)+'</span></div>'; });
    }
    let sec = null;
    f.questions.forEach(function(qq, i){
      if(qq.section && qq.section !== sec){ sec = qq.section; h += '<div class="mf-sec">'+_esc(sec)+'</div>'; }
      h += '<div class="mf-rq"><b>'+(i+1)+'.</b> '+_esc(qq.q)+'<div class="mf-opts">'
        + Object.keys(qq.options).map(k => '<span'+(k===qq.default?' class="mf-def" title="Form default"':'')+'><b>'+_esc(k)+'</b> '+_esc(qq.options[k])+'</span>').join('')
        + '</div></div>';
    });
    h += '</div></details>';
  });
  return h + '</div></div>';
}


/* ── Map Filters menu (build 2026-10-14b) ─────────────────────────────────
   Holds the set-once display toggles: Light/Dark map, labels, place names,
   relay animation. The buttons inside keep their ids and onclick handlers,
   so toggleStyle / toggleLabels / togglePlaces / toggleAnim are unchanged.
   The menu stays open while you click several; outside click or Esc closes.
   A dot on the menu button = something is changed from the default. */
function _mfmPlace(){
  const b = $('mapfilters-btn'), p = $('mapfilters-pop');
  if(!b || !p) return;
  const r = b.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8)) + 'px';
  p.style.top  = (r.bottom + 6) + 'px';
}
function toggleMapFilters(e, open){
  if(e) e.stopPropagation();
  const p = $('mapfilters-pop'), b = $('mapfilters-btn');
  if(!p) return;
  const show = (open === undefined) ? p.hidden : !!open;
  p.hidden = !show;
  if(b) b.classList.toggle('mfm-open', show);
  if(show) _mfmPlace();
}
function _mfmUpdateDot(){
  const t = id => (($(id) || {}).textContent || '');
  const v = id => (($(id) || {}).value || '');
  const changed = t('map-style-btn').indexOf('Dark Map') >= 0      // light map is on
               || t('label-btn').indexOf('Show Labels') >= 0       // labels hidden
               || t('places-btn').indexOf('Show Names') >= 0       // names hidden
               || t('anim-btn').indexOf('Anim Off') >= 0           // animation off
               || v('popup-select') === 'compact'                  // compact popups (29b)
               || (+v('new-filter-select') || 0) > 0               // New filter on (29b)
               || (+v('active-filter-select') || 0) > 0;           // Active filter on (29b)
  const d = $('mapfilters-dot');
  if(d) d.hidden = !changed;
  const b = $('mapfilters-btn');
  if(b) b.title = 'Light / dark map, labels, place names, relay animation, popup style, New and Active filters'
                + (changed ? ' — changed from default' : '');
}
(function(){
  const p = $('mapfilters-pop');
  if(!p) return;
  p.addEventListener('click', function(e){ e.stopPropagation(); });
  document.addEventListener('click', function(){ if(!p.hidden) toggleMapFilters(null, false); });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && !p.hidden) toggleMapFilters(null, false); });
  window.addEventListener('resize', function(){ if(!p.hidden) _mfmPlace(); });
  try{
    const mo = new MutationObserver(_mfmUpdateDot);
    ['map-style-btn','label-btn','places-btn','anim-btn'].forEach(function(id){
      const el = $(id); if(el) mo.observe(el, {childList:true, characterData:true, subtree:true});
    });
  }catch(e){}
  // Station display dropdowns (29b): refresh the dot when one changes.
  ['popup-select','new-filter-select','active-filter-select'].forEach(function(id){
    const el = $(id); if(el) el.addEventListener('change', _mfmUpdateDot);
  });
  _mfmUpdateDot();
})();



/* ── QSO messages in the station popup (build 2026-10-14g) ────────────────
   Typed conversation to or from the station, last 7 days, from /qso.json
   (the tagged traffic log). CQ, SNR, acks, heartbeats, queries, forms and
   StatReps are left out, as is decode garble such as 'AAAAAAAA'. Fetched
   fresh every time a station popup opens. */
map.on('popupopen', function(e){
  const el = e.popup.getElement();
  const box = el && el.querySelector('.qso-box');
  if(!box) return;
  const call = box.getAttribute('data-call') || '';
  const me = call.split('/')[0].toUpperCase();
  const link = function(c){
    if(!c) return '?';
    const cb = c.split('/')[0].toUpperCase();
    if(cb === me || c.charAt(0) === '@' || (typeof MY_CALL !== 'undefined' && cb === String(MY_CALL).split('/')[0].toUpperCase())) return _esc(c);
    return '<a href="#" class="qso-link" onclick="_qsoGoto(\''+_esc(c)+'\');return false;" title="Go to '+_esc(c)+' on the map">'+_esc(c)+'</a>';
  };
  fetch('/qso.json?call=' + encodeURIComponent(call) + '&hours=' + _srHours + '&_=' + Date.now())
    .then(r => r.ok ? r.json() : {messages:[]})
    .catch(() => ({messages:[]}))
    .then(function(d){
      const ms = (d && d.messages) || [];
      if(!ms.length){ box.innerHTML = ''; return; }
      let h = '<div class="p-divider"></div><div class="p-section-hdr">💬 QSO Messages ('+ms.length+') — '+_srWinLabel()+'</div><div class="qso-list">';
      ms.forEach(function(m){
        const mine = (typeof MY_CALL !== 'undefined') && m.to && m.to.split('/')[0] === MY_CALL;
        h += '<div class="qso-row'+(mine?' qso-mine':'')+'">'
           + '<div class="qso-top"><span class="qso-tag'+(m.tag==='MSG'?' qso-tag-msg':'')+'" title="'+(m.tag==='MSG'?'Stored message (MSG)':'Typed QSO message')+'">'+(m.tag==='MSG'?'MSG':'QSO')+'</span>'
           + '<span class="qso-dir">'+link(m.from)+' → '+link(m.to)+'</span>'
           + '<span class="qso-time" title="'+_esc(m.rx_time)+' UTC">'+_esc(_srLocal(m.rx_time))+'</span></div>'
           + '<div class="qso-txt">'+_esc(m.text)+'</div>'
           + (m.acks || []).map(a => '<div class="qso-ack" title="Acknowledged '+_esc(a.rx_time)+' UTC">✓ '+link(a.by)+' acked · '+_esc(_srLocal(a.rx_time).slice(7))+'</div>').join('')
           + '</div>';
      });
      box.innerHTML = h + '</div>';
      // resize / re-place only -- popup.update() would re-apply the original
      // content and wipe these messages
      try{ e.popup._updateLayout(); e.popup._updatePosition(); if(!e.popup._srDragged) e.popup._adjustPan(); }catch(_e){}
    });
});


/* ── QSO on the map (build 2026-10-14j) ────────────────────────────────────
   💬 badge on every station that exchanged real QSO text (or a stored MSG)
   in the last hour, and a teal dashed line between the two ends of a QSO
   when both are on the map. Data: /qso_active.json (the tagged traffic log,
   same rules as the popup -- no CQ / SNR / acks / heartbeats / garble).
   Older than 15 min = dimmer. Toggle: Map Filters ▸ 💬 QSO On/Off. */
map.createPane('qsoPane');
map.getPane('qsoPane').style.zIndex = 645;
const _qsoLayer = L.layerGroup().addTo(map);
let _qsoOn = _srSS('qso_on', 'true') !== 'false';
let _qsoData = null;

function _qsoEntry(call){
  const b = (call||'').split('/')[0].toUpperCase();
  return LAYERS.find(l => l && l.call && l.call.split('/')[0].toUpperCase() === b && l.marker && map.hasLayer(l.marker));
}
function _qsoAgeTxt(m){ return (m === null || m === undefined) ? '' : (m < 1 ? 'just now' : m + 'm ago'); }
function _qsoRender(){
  _qsoLayer.clearLayers();
  if(!_qsoOn || !_qsoData) return;
  (_qsoData.pairs || []).forEach(function(p){
    const a = _qsoEntry(p.a), b = _qsoEntry(p.b);
    if(!a || !b) return;
    const fresh = (p.age_min || 0) <= 15;
    L.polyline([a.marker.getLatLng(), b.marker.getLatLng()],
               {color:'#2dd4bf', weight:2.5, dashArray:'7 6', opacity: fresh ? 0.9 : 0.5, pane:'qsoPane'})
      .bindTooltip('💬 ' + _esc(p.a) + ' ⇄ ' + _esc(p.b) + ' · ' + p.count + ' msg' + (p.count === 1 ? '' : 's') + ' · ' + _qsoAgeTxt(p.age_min), {sticky:true})
      .addTo(_qsoLayer);
  });
  (_qsoData.stations || []).forEach(function(st){
    const e = _qsoEntry(st.call);
    if(!e) return;
    const fresh = (st.age_min || 0) <= 15;
    const icon = L.divIcon({className:'qso-icon', html:'<div class="qso-badge'+(fresh?'':' qso-old')+'">💬</div>',
                            iconSize:[20,20], iconAnchor:[-4, 26]});
    L.marker(e.marker.getLatLng(), {icon:icon, pane:'qsoPane', keyboard:false})
      .bindTooltip('💬 ' + _esc(st.call) + ' in QSO' + (st.peers.length ? ' with ' + st.peers.map(_esc).join(', ') : '')
                   + ' · ' + st.count + ' msg' + (st.count === 1 ? '' : 's') + ' · ' + _qsoAgeTxt(st.age_min),
                   {direction:'top', offset:[14,-26]})
      .on('click', function(){ e.marker.openPopup(); })
      .addTo(_qsoLayer);
  });
}
function _qsoPoll(){
  if(!_qsoOn){ _qsoLayer.clearLayers(); return; }
  fetch('/qso_active.json?minutes=' + Math.round(_srHours * 60) + '&_=' + Date.now())
    .then(r => r.ok ? r.json() : null).catch(() => null)
    .then(function(d){
      if(!d || d.error) return;
      _qsoData = d;
      const calls = new Set((d.stations || []).map(st => String(st.call).split('/')[0].toUpperCase()));
      const changed = !window._QSO_CALLS || calls.size !== window._QSO_CALLS.size || [...calls].some(c => !window._QSO_CALLS.has(c));
      window._QSO_CALLS = calls;
      if(changed && window.SR_VIEW === 'qso') applyFilters();   // QSO Only follows who is talking
      _qsoRender();
    });
}
function _qsoApplyBtn(){
  const b = $('qso-btn');
  if(b){ b.textContent = _qsoOn ? '✓ Show' : 'Show'; b.classList.toggle('show-on', _qsoOn); }
}
function toggleQsoLayer(){
  _qsoOn = !_qsoOn; _srSSet('qso_on', _qsoOn ? 'true' : 'false');
  if(!_qsoOn && window.SR_VIEW === 'qso') _srSetView('');
  _qsoApplyBtn(); _qsoPoll(); _qsoRender();
}
// Popup link: jump to the other station WITHOUT filtering the map (unlike
// Find callsign). Not on the map -> show it at its FCC address instead.
function _qsoGoto(call){
  const e = _qsoEntry(call) || LAYERS.find(l => l && l.call && l.call.split('/')[0].toUpperCase() === (call||'').split('/')[0].toUpperCase());
  map.closePopup();
  if(e && e.marker && map.hasLayer(e.marker)){
    _beginProgrammaticFit();
    map.flyTo(e.marker.getLatLng(), Math.max(map.getZoom(), 6), {duration:0.8});
    map.once('moveend', function(){ e.marker.openPopup(); });
  } else if(typeof _srLocate === 'function'){
    _srLocate(call, -1, call + ' is not on the map right now (filtered out or not heard here) — shown at the FCC address.');
  }
}
_qsoApplyBtn();
_qsoPoll();
setInterval(_qsoPoll, 20000);
map.on('zoomend', _qsoRender);


/* ── Popups: always fit, and can be dragged (build 2026-10-14m) ─────────────
   Every popup (stations, StatReps, MCForms):
   - its body is capped to the map height and scrolls inside, so the whole
     box -- header, buttons and all -- is always on screen;
   - the map pans it clear of the header and of the StatRep box;
   - a grab bar on top lets you drag it anywhere. After a drag the pointer
     tip is hidden and the map no longer re-pans for it; it snaps back to its
     station the next time it opens. Uses Leaflet's own L.Draggable and moves
     only the box (never popup.update(), which would wipe QSO messages). */
map.on('popupopen', function(e){
  const p = e.popup, c = p && p._container;
  if(!c) return;
  const content = c.querySelector('.leaflet-popup-content');
  if(content){
    content.style.maxHeight = Math.max(220, map.getSize().y - 140) + 'px';
    content.style.overflowY = 'auto';
  }
  const board = document.getElementById('sr-board');
  const bw = (board && board.offsetParent && !board.classList.contains('sr-min')) ? board.offsetWidth + 24 : 30;
  p.options.autoPan = true;
  p.options.autoPanPaddingTopLeft = L.point(24, 24);
  p.options.autoPanPaddingBottomRight = L.point(bw, 30);
  p._srDragged = false;
  c.classList.remove('pop-dragged');
  if(!c.querySelector('.pop-grip')){
    const grip = document.createElement('div');
    grip.className = 'pop-grip';
    grip.title = 'Drag to move this box';
    grip.innerHTML = '<span></span>';
    c.insertBefore(grip, c.firstChild);
    L.DomEvent.disableClickPropagation(grip);
    const drag = new L.Draggable(c, grip);
    drag.on('dragstart', function(){ p._srDragged = true; p.options.autoPan = false; c.classList.add('pop-dragged'); });
    drag.on('dragend', function(){
      const pos = L.DomUtil.getPosition(c);
      if(pos) p._latlng = map.layerPointToLatLng(pos);   // stays put through pan / zoom
    });
    drag.enable();
  }
  setTimeout(function(){ try{ p._updateLayout(); p._updatePosition(); if(!p._srDragged) p._adjustPan(); }catch(_e){} }, 60);
});


/* ── Toolbar feature groups: MCForms Show + Table buttons (build 2026-10-14o) ── */
function _mfApplyBtn(){
  const b = $('mcf-show-btn');
  if(b){ b.textContent = _mfOn ? '✓ Show' : 'Show'; b.classList.toggle('show-on', _mfOn); }
}
function toggleMfShow(){
  _mfOn = !_mfOn; _srSSet('mf_on', _mfOn ? 'true' : 'false');
  if(!_mfOn && window.SR_VIEW === 'mcf') _srSetView('');
  _mfApplyBtn(); _srRenderMarkers(); _srRenderBoard();
}
// Table buttons: open the table on that feature's tab; press again to close.
function _tblOpen(which){
  const tab = which === 'qso' ? 'traffic' : which;
  if(_srTblOn && _srTblTab === tab && (which !== 'qso' || _tblQsoMode)){ toggleStatRepTable(false); _tblApplyBtns(); return; }
  _tblQsoMode = (which === 'qso');
  if(_tblQsoMode){ Object.keys(_trFam).forEach(k => _trFam[k] = (k === 'qso')); _trTag = ''; }
  _srShowTab(tab);
  _tblApplyBtns();
}
let _tblQsoMode = false;
function _tblApplyBtns(){
  const open = typeof _srTblOn !== 'undefined' && _srTblOn;
  const t = typeof _srTblTab !== 'undefined' ? _srTblTab : '';
  [['cs-table-btn', open && t === 'statrep'], ['mf-table-btn', open && t === 'forms'],
   ['qso-table-btn', open && t === 'traffic' && _tblQsoMode]].forEach(function(x){
    const b = $(x[0]); if(b) b.classList.toggle('table-on', !!x[1]);
  });
}
(function(){            // keep the Table buttons in step when the table is opened or closed elsewhere
  const _origToggle = toggleStatRepTable;
  window.toggleStatRepTable = toggleStatRepTable = function(on){ _origToggle(on); if(!_srTblOn) _tblQsoMode = false; _tblApplyBtns(); };
  const _origShow = _srShowTab;
  window._srShowTab = _srShowTab = function(k){ if(k !== 'traffic') _tblQsoMode = false; _origShow(k); _tblApplyBtns(); };
})();
_mfApplyBtn();
_srApplyBtn();
_srApplyOnlyBtn();
_tblApplyBtns();
