#!/usr/bin/env python3
"""
js8map_statrep.py  --  CommStat StatRep / Alert / RRSR support for JS8Map.

WHAT THIS MODULE DOES
=====================
  1. PARSES the structured CommStat traffic that rides inside ordinary JS8Call
     directed messages:
        StatRep    CALL: @GROUP ,GRID,SCOPE,SRID,STATUS12,REMARKS,{&%}
                   ({&%3} = sent via the CommStat internet backbone,
                    {F%}  = forwarded on behalf of another station,
                    STATUS12 may be the single character '+' = all green)
        Alert      CALL: @GROUP ,ALERTID,COLOR,TITLE,MESSAGE,{%%}
                   (older form without ALERTID also accepted)
        RRSR ack   CALL: @GROUP RRSR TARGETCALL,SRID
  2. STORES them in its OWN SQLite file (js8map_statrep.db in the data
     folder). Deliberately NOT js8_spots.db: that file is cleared on QSY /
     Clear Map and is FastChat's read contract. A StatRep is a report, not a
     spot -- it must survive a band change.
  3. FEEDS from two places:
        a) live -- JS8CallClient hands every RX.DIRECTED and RX.ACTIVITY
           frame to StatRepSink.feed() (same JS8Call TCP API JS8Spotter uses);
        b) history -- JS8SpotterImporter reads JS8Spotter's js8spotter.db
           READ-ONLY and picks up any StatRep traffic it captured, including
           reports heard while JS8Map was not running.
     Both paths go through the same parser and the same de-duplication, so a
     report heard by both apps is stored once (its 'sources' lists both).
  4. SERVES /statrep.json to the map page via build_payload().
  5. MCFORMS (JS8Spotter / SitRepNet micro forms, 'F!309 ...') are stored raw
     in table mcform and decoded against the form files when served -- see
     js8map_forms.py. Every directed message heard is also kept, with one
     tag, in table traffic (7 days) for the map page's Traffic view.

JS8Map NEVER transmits anything from this module -- no auto-RRSR ack. That
stays CommStat's job (and is gated by its own rf_ack setting there).

Leaf module: stdlib + js8map_util only. The grid resolver (spot DB / FCC) is
injected by the composition root so this file has no back-imports.
"""
from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone

from js8map_util import grid_to_latlon, is_valid_grid
from js8map_forms import (has_form, parse_form_message, decode_form, tag_message,
                          is_qso_text, FORMS_REV)

# ── CommStat vocabulary (mirrors CommStat statrep.py / constants.py) ─────────
# Order matters: this is the order of the 12 digits on the wire.
CATEGORIES = [
    ('map',      'Map Pin'),   # overall status the sender chose for the pin
    ('power',    'Power'),
    ('water',    'Water'),
    ('medical',  'Medical'),
    ('comms',    'Comms'),
    ('travel',   'Travel'),
    ('internet', 'Internet'),
    ('fuel',     'Fuel'),
    ('food',     'Food'),
    ('crime',    'Crime'),
    ('civil',    'Civil'),
    ('weather',  'Weather'),   # CommStat's DB column is 'political'; form label is Weather
]
STATUS_NAME = {'1': 'Green', '2': 'Yellow', '3': 'Red', '4': 'Unknown',
               '6': 'Event', '7': 'Attack'}
# Severity for "worst of" -- Unknown ranks above Green (not confirmed OK),
# exactly as CommStat's Map Pin auto-flip does.
_SEVERITY = {'3': 4, '7': 4, '2': 3, '6': 3, '4': 1, '1': 0}
SCOPE_NAME = {'1': 'My QTH', '2': 'Community', '3': 'County', '4': 'Region',
              '5': 'Other Location'}
ALERT_COLOR = {1: 'Yellow', 2: 'Orange', 3: 'Red', 4: 'Black'}

# Visible on the map board footer so the operator can tell at a glance which
# StatRep build is actually running (several same-named zips went out).
STATREP_BUILD = '2026-10-29e'
# Bump when parse_message learns something new. On the next import the
# JS8Spotter watermark is reset so its history is read again with the new
# rules (safe: everything already stored is de-duplicated, nothing is lost).
PARSER_REV = '4'   # 3 = partial StatReps + lost-frame messages; 4 = MCForms

DB_FILENAME = 'js8map_statrep.db'
_TS_FMT = '%Y-%m-%d %H:%M:%S'          # stored UTC, no suffix

# A report and the same report heard again (other app, backbone copy, a
# forward) is the same report if call+SRID+status match within this window.
_DUP_WINDOW_S = 12 * 3600
# The traffic log is every directed message heard -- kept a week, not a month.
TRAFFIC_DAYS = 7
_TRAFFIC_DUP_S = 600          # same sender + same text within 10 min = one entry

# ── Text clean-up ────────────────────────────────────────────────────────────
# JS8Call ends every directed message with the end-of-message diamond U+2662.
# Anything that re-encodes that text badly (JS8Spotter's database view is one)
# turns it into runs of mojibake like 'ÃÂÃÂ¢...'. Nothing is lost -- it was
# only ever the diamond -- so non-ASCII is simply dropped, exactly as
# CommStat's sanitize_ascii() does.
_NON_ASCII = re.compile(r'[^ -~]+')
_SPACES = re.compile(r'\s+')


def clean_text(s) -> str:
    s = _NON_ASCII.sub(' ', str(s or ''))
    return _SPACES.sub(' ', s).strip()


_CALL = r'[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(?:/[A-Z0-9]{1,4})?'
_CALL_RE = re.compile(r'^' + _CALL + r'$', re.I)
_PREFIX_RE = re.compile(r'^(' + _CALL + r'):\s*', re.I)


def base_call(call: str) -> str:
    return (call or '').upper().split('/')[0].strip()


def _strip_prefix(text: str):
    """'N0ASH: @AMRRON ,...' -> ('N0ASH', '@AMRRON ,...').
    Also collapses the JS8Call doubled-prefix bug 'K7RIE: K7RIE: @MAGNET'."""
    m = _PREFIX_RE.match(text)
    if not m:
        return '', text
    call = m.group(1).upper()
    rest = text[m.end():]
    m2 = _PREFIX_RE.match(rest)
    if m2 and base_call(m2.group(1)) == base_call(call):
        rest = rest[m2.end():]
    return call, rest


# ── Parsers ──────────────────────────────────────────────────────────────────
_SR_RE = re.compile(
    r'^(?P<to>@?[A-Z0-9/]+)\s*,(?P<body>.*?)\{(?P<mk>&%3?|F%)\}', re.I)
_ALERT_RE = re.compile(r'^(?P<to>@?[A-Z0-9/]+)\s*,(?P<body>.*?),?\s*\{%%3?\}', re.I)
_ALERT_LRT_RE = re.compile(r'^LRT\s*,(?P<body>.*?),?\s*\{%%3?\}', re.I)
_RRSR_RE = re.compile(
    r'^(?P<to>@?[A-Z0-9/]+)\s+RRSR\s+(?P<target>[A-Z0-9/]{3,12})\s*,\s*(?P<srid>[A-Z0-9]{3})\b',
    re.I)


def has_marker(text: str) -> bool:
    t = text or ''
    return ('{&%' in t) or ('{F%}' in t) or ('{%%' in t) or (' RRSR ' in t.upper())


# ── Lost frames ──────────────────────────────────────────────────────────────
# JS8Call writes '……' (U+2026) where frames of a message were not decoded.
# JS8Spotter's database stores that (and the end-of-message diamond) after
# several rounds of latin-1/UTF-8 mis-encoding, so '…' shows up as long runs
# of 'ÃÂÃÂ…'. unwind_mojibake() peels those rounds back off.
_ELLIPSIS = '\u2026'


def unwind_mojibake(s: str) -> str:
    s = s or ''
    for _ in range(12):
        try:
            b = s.encode('latin-1')
        except UnicodeEncodeError:
            break
        try:
            t = b.decode('utf-8')
        except UnicodeDecodeError as e:     # JS8Spotter truncates long values
            t = b[:e.start].decode('utf-8', 'ignore') + b[e.start:].decode('latin-1')
            if t == s:
                break
        if t == s:
            break
        s = t
    return s


def lost_frames(text: str) -> bool:
    """True when JS8Call marked part of this message as not decoded."""
    t = text or ''
    if _ELLIPSIS in t:
        return True
    return ('\u00c3' in t or '\u00e2' in t) and _ELLIPSIS in unwind_mojibake(t)


# A StatRep whose start decoded but whose tail (and {&%} marker) was lost:
# accepted only when every field up to the 12-digit status is intact.
_SR_PART_RE = re.compile(
    r'^(?P<to>@?[A-Z0-9/]+)\s*,\s*(?P<grid>[A-R]{2}[0-9]{2}(?:[A-X]{2})?)?\s*,\s*'
    r'(?P<scope>[1-5])\s*,\s*(?P<srid>[A-Z0-9]{3})\s*,\s*(?P<code>\+|[0-9]{12})'
    r'(?:\s*,\s*(?P<rem>.*))?$', re.I)


def parse_message(text: str, from_call: str = '', to_call: str = ''):
    """Classify one complete message. Returns a dict with 'kind' in
    {'statrep','alert','ack'} or None. from_call/to_call are the JS8Call
    params when known; the text prefix wins for the report's originator
    (a forwarded report's prefix is the ORIGINAL station)."""
    raw = clean_text(text)
    lost = lost_frames(text)
    if not raw or not (has_marker(raw) or lost or has_form(raw)):
        return None
    pfx_call, body = _strip_prefix(raw)
    rx_from = (from_call or '').upper().strip()
    sender = pfx_call or rx_from
    if not sender:
        return None

    # ── StatRep ──
    m = _SR_RE.match(body)
    if m:
        # Positional: a BLANK grid (',,1,B07,...') must stay an empty first
        # field, never be dropped -- dropping it shifts every field left.
        fields = [f.strip() for f in m.group('body').split(',')]
        if len(fields) < 4:
            return None
        grid, scope, srid, code = fields[0].upper(), fields[1], fields[2].upper(), fields[3]
        if code == '+':
            code = '1' * 12
        if len(code) < 12 or not code[:12].isdigit():
            return None
        code = code[:12]
        remarks = ','.join(f for f in fields[4:] if f).strip()
        forwarded = m.group('mk').upper() == 'F%'
        relay = ''
        if rx_from and base_call(rx_from) != base_call(sender):
            relay = rx_from                      # someone else sent it on air
        return {
            'kind': 'statrep',
            'from_call': sender,
            'to_call': m.group('to').upper(),
            'grid': grid if is_valid_grid(grid) else '',
            'scope': scope if scope in SCOPE_NAME else scope[:12],
            'sr_id': srid[:3],
            'status': code,
            'remarks': remarks[:240],
            'forwarded': forwarded or bool(relay),
            'relay': relay,
            'internet': m.group('mk') == '&%3',
            'raw': raw[:400],
        }

    # ── Alert ──
    m = _ALERT_RE.match(body)
    to = m.group('to').upper() if m else ''
    if not m:
        m = _ALERT_LRT_RE.match(body)
        to = (to_call or '@ALL').upper()
    if m:
        body_s = m.group('body').strip().lstrip(',').strip()
        f = [x.strip() for x in body_s.split(',', 3)]
        alert_id, color, title, msg = '', None, '', ''
        if len(f) >= 4 and not f[0].isdigit() and f[1].isdigit():
            alert_id, color, title, msg = f[0].upper()[:4], int(f[1]), f[2], f[3]
        elif len(f) >= 3 and f[0].isdigit():
            g = [x.strip() for x in body_s.split(',', 2)]
            color, title, msg = int(g[0]), g[1], g[2]
        else:
            return None
        return {
            'kind': 'alert', 'from_call': sender, 'to_call': to,
            'alert_id': alert_id, 'color': color if color in ALERT_COLOR else 4,
            'title': title[:80], 'message': msg.rstrip(',').strip()[:300],
            'raw': raw[:400],
        }

    # ── RRSR acknowledgement ──
    m = _RRSR_RE.match(body)
    if m:
        return {
            'kind': 'ack', 'from_call': sender, 'to_call': m.group('to').upper(),
            'target': m.group('target').upper(), 'sr_id': m.group('srid').upper(),
            'raw': raw[:200],
        }

    # ── MCForms report / request ('F!309 ...', 'E? F!305') ──
    if has_form(body):
        rec = parse_form_message(sender + ': ' + body, sender, to_call)
        if rec:
            if rec['kind'] == 'form':
                rec['partial'] = bool(lost)
                rec['relay'] = (rx_from if rx_from and base_call(rx_from) != base_call(sender) else '')
            return rec

    if lost:
        # ── Partial StatRep: start decoded, tail + {&%} lost ──
        m = _SR_PART_RE.match(body)
        if m:
            code = m.group('code')
            code = '1' * 12 if code == '+' else code
            grid = (m.group('grid') or '').upper()
            return {
                'kind': 'statrep', 'partial': True,
                'from_call': sender, 'to_call': m.group('to').upper(),
                'grid': grid if is_valid_grid(grid) else '',
                'scope': m.group('scope'), 'sr_id': m.group('srid').upper()[:3],
                'status': code, 'remarks': (m.group('rem') or '').strip(' ,')[:240],
                'forwarded': False, 'relay': '', 'internet': False, 'raw': raw[:400],
            }
        # ── Group message that lost its frames (could have been anything,
        #    often a StatRep -- an RRSR for this call later tells you which) ──
        mg = re.match(r'^(@[A-Z0-9/]+)\s*(.*)$', body, re.I)
        if mg:
            return {'kind': 'lost', 'from_call': sender, 'to_call': mg.group(1).upper(),
                    'text': mg.group(2).strip()[:120], 'raw': raw[:200]}
    return None


# ── Store ────────────────────────────────────────────────────────────────────
def _utc_now():
    return datetime.now(timezone.utc)


def _fmt(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime(_TS_FMT)


def _parse_ts(s: str):
    try:
        return datetime.strptime(str(s)[:19], _TS_FMT).replace(tzinfo=timezone.utc)
    except Exception:
        return None


class StatRepStore:
    """Thread-safe SQLite store. One short-lived connection per call (the
    same pattern SpotDatabase uses) so the client thread, the HTTP thread and
    the importer thread never share a connection."""

    def __init__(self, db_path: str, retention_days: int = 30):
        self.path = db_path
        self.retention_days = retention_days
        self._lock = threading.Lock()
        self._rev = 0                 # bumps on every change -> cheap change check
        self._rev_lock = threading.Lock()   # _rev changes inside AND outside _lock
        self._boot = format(int(time.time()), 'x')   # makes rev_tag unique per run
        self._init()
        self.purge_old()

    def _connect(self):
        c = sqlite3.connect(self.path, timeout=15)
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA synchronous=NORMAL')
        return c

    def _init(self):
        with self._lock, self._connect() as c:
            c.executescript('''
            CREATE TABLE IF NOT EXISTS statrep(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_call TEXT NOT NULL, base_call TEXT NOT NULL,
                to_call TEXT, relay_call TEXT, grid TEXT, scope TEXT,
                sr_id TEXT, status TEXT NOT NULL, remarks TEXT,
                forwarded INTEGER DEFAULT 0, internet INTEGER DEFAULT 0,
                freq REAL DEFAULT 0, snr REAL,
                sources TEXT, rx_time TEXT NOT NULL, raw TEXT);
            CREATE INDEX IF NOT EXISTS ix_sr_call ON statrep(base_call, sr_id);
            CREATE INDEX IF NOT EXISTS ix_sr_time ON statrep(rx_time);
            CREATE TABLE IF NOT EXISTS statrep_ack(
                target_base TEXT, sr_id TEXT, ack_call TEXT, rx_time TEXT,
                UNIQUE(target_base, sr_id, ack_call));
            CREATE TABLE IF NOT EXISTS statrep_alert(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_call TEXT, to_call TEXT, alert_id TEXT, color INTEGER,
                title TEXT, message TEXT, sources TEXT, rx_time TEXT, raw TEXT);
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS statrep_lost(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_call TEXT, base_call TEXT, to_call TEXT, text TEXT,
                sources TEXT, rx_time TEXT);
            CREATE TABLE IF NOT EXISTS mcform(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_call TEXT NOT NULL, base_call TEXT NOT NULL, to_call TEXT,
                relay_call TEXT, form_id TEXT NOT NULL, answers TEXT,
                fields TEXT, comment TEXT, datecode TEXT, grid TEXT,
                partial INTEGER DEFAULT 0, freq REAL DEFAULT 0, snr REAL,
                sources TEXT, rx_time TEXT NOT NULL, raw TEXT);
            CREATE INDEX IF NOT EXISTS ix_mcf_call ON mcform(base_call, form_id);
            CREATE INDEX IF NOT EXISTS ix_mcf_time ON mcform(rx_time);
            CREATE TABLE IF NOT EXISTS traffic(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_call TEXT, to_call TEXT, tag TEXT, family TEXT,
                text TEXT, freq REAL DEFAULT 0, snr REAL, rx_time TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS ix_trf_time ON traffic(rx_time);
            ''')
            cols = [r[1] for r in c.execute('PRAGMA table_info(statrep)').fetchall()]
            if 'partial' not in cols:
                c.execute('ALTER TABLE statrep ADD COLUMN partial INTEGER DEFAULT 0')

    # meta (importer watermark etc.)
    def get_meta(self, key, default=''):
        with self._lock, self._connect() as c:
            r = c.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return r[0] if r else default

    def set_meta(self, key, value):
        with self._lock, self._connect() as c:
            c.execute('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', (key, str(value)))

    @property
    def rev(self):
        return self._rev

    @property
    def rev_tag(self) -> str:
        """Changes whenever anything in the store changes, and on every
        program start. The map page sends it back to skip unchanged polls."""
        return f'{self._boot}.{self._rev}'

    def _bump(self):
        with self._rev_lock:
            self._rev += 1

    def _add_source(self, c, table, row_id, existing, source):
        srcs = [s for s in (existing or '').split(',') if s]
        if source and source not in srcs:
            srcs.append(source)
            c.execute(f'UPDATE {table} SET sources=? WHERE id=?', (','.join(srcs), row_id))
            return True
        return False

    def add(self, rec: dict, rx_time: datetime, source: str, freq=0.0, snr=None) -> str:
        """Insert a parsed record. Returns 'new', 'dup' or ''."""
        if not rec:
            return ''
        kind = rec['kind']
        ts = _fmt(rx_time)
        with self._lock, self._connect() as c:
            if kind == 'statrep':
                bc = base_call(rec['from_call'])
                for rid, rtime, srcs, status in c.execute(
                        'SELECT id, rx_time, sources, status FROM statrep '
                        'WHERE base_call=? AND sr_id=?', (bc, rec['sr_id'])).fetchall():
                    t0 = _parse_ts(rtime)
                    if (t0 and status == rec['status']
                            and abs((t0 - rx_time).total_seconds()) <= _DUP_WINDOW_S):
                        if self._add_source(c, 'statrep', rid, srcs, source):
                            self._bump()
                        # a complete copy replaces a partial one's remarks
                        if not rec.get('partial'):
                            cur = c.execute('UPDATE statrep SET remarks=?, raw=?, partial=0, '
                                            'grid=CASE WHEN grid=\'\' THEN ? ELSE grid END '
                                            'WHERE id=? AND partial=1',
                                            (rec['remarks'], rec['raw'], rec['grid'], rid))
                            if cur.rowcount:
                                self._bump()
                        # live copy carries freq/SNR the history copy may lack
                        if freq:
                            c.execute('UPDATE statrep SET freq=?, snr=COALESCE(snr,?) '
                                      'WHERE id=? AND (freq IS NULL OR freq=0)',
                                      (freq, snr, rid))
                        return 'dup'
                c.execute(
                    'INSERT INTO statrep(from_call,base_call,to_call,relay_call,grid,scope,'
                    'sr_id,status,remarks,forwarded,internet,freq,snr,sources,rx_time,raw,partial) '
                    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    (rec['from_call'], bc, rec['to_call'], rec.get('relay', ''),
                     rec['grid'], rec['scope'], rec['sr_id'], rec['status'],
                     rec['remarks'], int(rec['forwarded']), int(rec.get('internet', False)),
                     freq or 0, snr, source, ts, rec['raw'], int(bool(rec.get('partial')))))
            elif kind == 'ack':
                cur = c.execute(
                    'INSERT OR IGNORE INTO statrep_ack(target_base,sr_id,ack_call,rx_time) '
                    'VALUES(?,?,?,?)',
                    (base_call(rec['target']), rec['sr_id'], rec['from_call'], ts))
                if not cur.rowcount:
                    return 'dup'
            elif kind == 'lost':
                bc = base_call(rec['from_call'])
                for rid, rtime, srcs in c.execute(
                        'SELECT id, rx_time, sources FROM statrep_lost WHERE base_call=?',
                        (bc,)).fetchall():
                    t0 = _parse_ts(rtime)
                    if t0 and abs((t0 - rx_time).total_seconds()) <= 90:
                        if self._add_source(c, 'statrep_lost', rid, srcs, source):
                            self._bump()
                        return 'dup'
                c.execute('INSERT INTO statrep_lost(from_call,base_call,to_call,text,sources,rx_time) '
                          'VALUES(?,?,?,?,?,?)',
                          (rec['from_call'], bc, rec['to_call'], rec.get('text', ''), source, ts))
            elif kind == 'alert':
                for rid, rtime, srcs in c.execute(
                        'SELECT id, rx_time, sources FROM statrep_alert WHERE from_call=? '
                        'AND title=? AND message=?',
                        (rec['from_call'], rec['title'], rec['message'])).fetchall():
                    t0 = _parse_ts(rtime)
                    if t0 and abs((t0 - rx_time).total_seconds()) <= _DUP_WINDOW_S:
                        if self._add_source(c, 'statrep_alert', rid, srcs, source):
                            self._bump()
                        return 'dup'
                c.execute(
                    'INSERT INTO statrep_alert(from_call,to_call,alert_id,color,title,'
                    'message,sources,rx_time,raw) VALUES(?,?,?,?,?,?,?,?,?)',
                    (rec['from_call'], rec['to_call'], rec['alert_id'], rec['color'],
                     rec['title'], rec['message'], source, ts, rec['raw']))
            elif kind == 'form':
                return self._add_form(c, rec, rx_time, ts, source, freq, snr)
            else:
                return ''
        self._bump()
        return 'new'

    def _add_form(self, c, rec, rx_time, ts, source, freq, snr) -> str:
        """Same report = same station + form + datecode within 12 h (or, when
        no datecode came through, the same answers and fields). A longer copy
        of a report heard cut short replaces the short one."""
        bc = base_call(rec['from_call'])
        fields_js = json.dumps(rec['fields'], sort_keys=True)
        for rid, rtime, srcs, ans, flds, dc, part in c.execute(
                'SELECT id, rx_time, sources, answers, fields, datecode, partial FROM mcform '
                'WHERE base_call=? AND form_id=?', (bc, rec['form_id'])).fetchall():
            t0 = _parse_ts(rtime)
            if not t0 or abs((t0 - rx_time).total_seconds()) > _DUP_WINDOW_S:
                continue
            if dc and rec['datecode']:
                same = dc == rec['datecode']
            else:                       # one copy lost its datecode: compare answers
                a0, a1 = ans or '', rec['answers']
                same = ((a0.startswith(a1) or a1.startswith(a0))
                        and (bool(a0 and a1) or fields_js == (flds or '{}')))
            if not same:
                continue
            changed = self._add_source(c, 'mcform', rid, srcs, source)
            if len(rec['answers']) > len(ans or '') or (part and not rec.get('partial')) \
                    or len(fields_js) > len(flds or ''):
                c.execute('UPDATE mcform SET answers=?, fields=?, comment=?, grid=?, raw=?, '
                          'partial=?, datecode=? WHERE id=?',
                          (rec['answers'], fields_js, rec['comment'], rec['grid'], rec['raw'],
                           int(bool(rec.get('partial'))), rec['datecode'] or dc, rid))
                changed = True
            if freq:
                c.execute('UPDATE mcform SET freq=?, snr=COALESCE(snr,?) '
                          'WHERE id=? AND (freq IS NULL OR freq=0)', (freq, snr, rid))
            if changed:
                self._bump()
            return 'dup'
        c.execute('INSERT INTO mcform(from_call,base_call,to_call,relay_call,form_id,answers,'
                  'fields,comment,datecode,grid,partial,freq,snr,sources,rx_time,raw) '
                  'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                  (rec['from_call'], bc, rec['to_call'], rec.get('relay', ''), rec['form_id'],
                   rec['answers'], fields_js, rec['comment'], rec['datecode'], rec['grid'],
                   int(bool(rec.get('partial'))), freq or 0, snr, source, ts, rec['raw']))
        self._bump()
        return 'new'

    def add_traffic(self, from_call, to_call, text, tag, family, rx_time,
                    freq=0.0, snr=None) -> bool:
        """One line in the tagged traffic log. Repeats within 10 min are dropped."""
        text = clean_text(text)[:300]
        if not text or not from_call:
            return False
        ts = _fmt(rx_time)
        # Acks repeat word for word ('WA8WQU ACK' for every message answered),
        # so for them only a copy within 90 s is the same ack heard twice.
        cut = _fmt(rx_time - timedelta(seconds=90 if tag == 'ACK' else _TRAFFIC_DUP_S))
        with self._lock, self._connect() as c:
            # Same sender, same message within 10 min -> one entry. A copy that
            # only EXTENDS (or is cut short of) one already logged is the same
            # message too: keep the longer text. (Late frames after the end
            # marker, or the RX.DIRECTED and band-activity copies differing.)
            for rid, old in c.execute('SELECT id, text FROM traffic WHERE from_call=? AND rx_time>=? '
                                      'ORDER BY id DESC LIMIT 20', (from_call, cut)).fetchall():
                old = old or ''
                if old == text or old.startswith(text):
                    return False
                if text.startswith(old) and len(old) >= 12:
                    c.execute('UPDATE traffic SET text=?, tag=?, family=? WHERE id=?',
                              (text, tag, family, rid))
                    self._bump()
                    return False
            c.execute('INSERT INTO traffic(from_call,to_call,tag,family,text,freq,snr,rx_time) '
                      'VALUES(?,?,?,?,?,?,?,?)',
                      (from_call, to_call or '', tag, family, text, freq or 0, snr, ts))
        self._bump()
        return True

    def purge_old(self):
        cut = _fmt(_utc_now() - timedelta(days=self.retention_days))
        with self._lock, self._connect() as c:
            c.execute('DELETE FROM statrep WHERE rx_time < ?', (cut,))
            c.execute('DELETE FROM statrep_ack WHERE rx_time < ?', (cut,))
            c.execute('DELETE FROM statrep_alert WHERE rx_time < ?', (cut,))
            c.execute('DELETE FROM statrep_lost WHERE rx_time < ?', (cut,))
            c.execute('DELETE FROM mcform WHERE rx_time < ?', (cut,))
            c.execute('DELETE FROM traffic WHERE rx_time < ?',
                      (_fmt(_utc_now() - timedelta(days=TRAFFIC_DAYS)),))

    def clear_all(self):
        with self._lock, self._connect() as c:
            c.execute('DELETE FROM statrep')
            c.execute('DELETE FROM statrep_ack')
            c.execute('DELETE FROM statrep_alert')
            c.execute('DELETE FROM statrep_lost')
            c.execute('DELETE FROM mcform')
            c.execute('DELETE FROM traffic')
        self._bump()

    def counts(self) -> dict:
        with self._lock, self._connect() as c:
            return {
                'reports': c.execute('SELECT COUNT(*) FROM statrep').fetchone()[0],
                'stations': c.execute('SELECT COUNT(DISTINCT base_call) FROM statrep').fetchone()[0],
                'alerts': c.execute('SELECT COUNT(*) FROM statrep_alert').fetchone()[0],
                'acks': c.execute('SELECT COUNT(*) FROM statrep_ack').fetchone()[0],
                'lost': c.execute('SELECT COUNT(*) FROM statrep_lost').fetchone()[0],
                'forms': c.execute('SELECT COUNT(*) FROM mcform').fetchone()[0],
                'traffic': c.execute('SELECT COUNT(*) FROM traffic').fetchone()[0],
            }

    def query_forms(self, since: datetime):
        with self._lock, self._connect() as c:
            return c.execute(
                'SELECT id,from_call,base_call,to_call,relay_call,form_id,answers,fields,'
                'comment,datecode,grid,partial,freq,snr,sources,rx_time FROM mcform '
                'WHERE rx_time >= ? ORDER BY rx_time DESC', (_fmt(since),)).fetchall()

    def query_qso(self, call: str, days: float = 7, limit: int = 12):
        """Typed QSO messages to or from one station (newest first) for the
        station popup. Leaves out CQ / SNR / acks / heartbeats (other tags)
        and decode garble such as 'AAAAAAAA'. Rows logged before the QSO tag
        existed (tag TEXT) are judged the same way."""
        bc = base_call(call)
        if not bc:
            return []
        cut = _fmt(_utc_now() - timedelta(days=days))
        with self._lock, self._connect() as c:
            rows = c.execute(
                "SELECT from_call,to_call,tag,text,freq,snr,rx_time FROM traffic "
                "WHERE rx_time >= ? AND tag IN ('QSO','TEXT','MSG','ACK') AND "
                "(from_call=? OR from_call LIKE ? OR to_call=? OR to_call LIKE ?) "
                "ORDER BY rx_time DESC, id DESC LIMIT 300",
                (cut, bc, bc + '/%', bc, bc + '/%')).fetchall()
        acks = [(base_call(f), base_call(t or ''), _parse_ts(ts), ts)
                for f, t, tag, _x, _fq, _s, ts in rows if tag == 'ACK']
        rows = [r for r in rows if r[2] != 'ACK']
        out, kept = [], []
        for frm, to, tag, text, freq, snr, ts in rows:
            if tag != 'MSG' and not is_qso_text(text):
                continue
            # an older, shorter copy of a message already shown (logged before
            # build 14k merged them) -- skip it
            t0 = _parse_ts(ts)
            if any(k[0] == frm and k[1].startswith(text) and t0 and k[2]
                   and abs((k[2] - t0).total_seconds()) <= _TRAFFIC_DUP_S for k in kept):
                continue
            kept.append((frm, text, t0))
            words = text
            if to and words.upper().startswith(to.upper() + ' '):
                words = words[len(to) + 1:]                # drop the leading recipient
            if tag == 'MSG' and words.upper().startswith('MSG '):
                words = words[4:]                           # the MSG tag already says so
            out.append({'from': frm, 'to': to or '', 'tag': 'MSG' if tag == 'MSG' else 'QSO',
                        'text': words.strip(), 'freq': freq or 0, 'snr': snr, 'rx_time': ts})
            if len(out) >= limit:
                break
        # Attach each ack to the message it answers: an ack FROM the recipient
        # TO the sender, after the message and before that sender's next
        # message to the same station (at most 15 min later). Each ack once.
        used = set()
        for m in sorted(out, key=lambda m: m['rx_time']):
            m['acks'] = []
            a, b = base_call(m['from']), base_call(m['to'])
            t0 = _parse_ts(m['rx_time'])
            if not (a and b and t0):
                continue
            nxt = [_parse_ts(x['rx_time']) for x in out
                   if base_call(x['from']) == a and base_call(x['to']) == b and x['rx_time'] > m['rx_time']]
            t1 = min([t for t in nxt if t] + [t0 + timedelta(minutes=15)])
            for i, (af, at, tk, ts) in enumerate(acks):
                if i in used or af != b or at != a or not tk:
                    continue
                if t0 <= tk <= t1:
                    used.add(i)
                    m['acks'].append({'by': af, 'rx_time': ts})
        return out

    def query_qso_active(self, minutes: float = 60) -> dict:
        """Stations in a real QSO recently -- for the map's 💬 badges and the
        dashed lines between the two ends of a QSO. Same rules as query_qso
        (typed text and stored MSGs only, no garble)."""
        cut = _fmt(_utc_now() - timedelta(minutes=minutes))
        with self._lock, self._connect() as c:
            rows = c.execute(
                "SELECT from_call,to_call,tag,text,rx_time FROM traffic "
                "WHERE rx_time >= ? AND tag IN ('QSO','TEXT','MSG') ORDER BY rx_time",
                (cut,)).fetchall()
        now = _utc_now()
        stations, pairs = {}, {}
        for frm, to, tag, text, ts in rows:
            if tag != 'MSG' and not is_qso_text(text):
                continue
            a = base_call(frm)
            b = base_call(to) if to and not to.startswith('@') else ''
            t = _parse_ts(ts)
            age = int((now - t).total_seconds() // 60) if t else None
            for me, other in ((a, b or (to or '')), (b, a)):
                if not me:
                    continue
                st = stations.setdefault(me, {'call': me, 'count': 0, 'peers': [], 'last': ts, 'age_min': age})
                st['count'] += 1
                st['last'], st['age_min'] = ts, age
                if other and other not in st['peers']:
                    st['peers'].append(other)
            if a and b:
                k = tuple(sorted((a, b)))
                pr = pairs.setdefault(k, {'a': k[0], 'b': k[1], 'count': 0, 'last': ts, 'age_min': age})
                pr['count'] += 1
                pr['last'], pr['age_min'] = ts, age
        return {'minutes': minutes, 'stations': list(stations.values()), 'pairs': list(pairs.values())}

    def query_traffic(self, since: datetime, limit: int = 600):
        with self._lock, self._connect() as c:
            return c.execute(
                'SELECT id,from_call,to_call,tag,family,text,freq,snr,rx_time FROM traffic '
                'WHERE rx_time >= ? ORDER BY rx_time DESC, id DESC LIMIT ?',
                (_fmt(since), int(limit))).fetchall()

    def query(self, since: datetime):
        """-> (reports, acks, alerts, lost) since a time. Returned together so
        concurrent requests never share state on the store."""
        cut = _fmt(since)
        with self._lock, self._connect() as c:
            reps = c.execute(
                'SELECT id,from_call,base_call,to_call,relay_call,grid,scope,sr_id,status,'
                'remarks,forwarded,internet,freq,snr,sources,rx_time,partial FROM statrep '
                'WHERE rx_time >= ? ORDER BY rx_time DESC', (cut,)).fetchall()
            lost = c.execute(
                'SELECT from_call,base_call,to_call,text,sources,rx_time FROM statrep_lost '
                'WHERE rx_time >= ? ORDER BY rx_time', (cut,)).fetchall()
            acks = c.execute(
                'SELECT target_base,sr_id,ack_call,rx_time FROM statrep_ack '
                'WHERE rx_time >= ?', (_fmt(since - timedelta(days=1)),)).fetchall()
            alerts = c.execute(
                'SELECT id,from_call,to_call,alert_id,color,title,message,sources,rx_time '
                'FROM statrep_alert WHERE rx_time >= ? ORDER BY rx_time DESC', (cut,)).fetchall()
        return reps, acks, alerts, lost


# ── Payload for the map page ─────────────────────────────────────────────────
def worst_of(status: str) -> str:
    """Worst digit among the 11 categories after Map Pin."""
    w, wr = '1', -1
    for d in status[1:12]:
        r = _SEVERITY.get(d, -1)
        if r > wr:
            w, wr = d, r
    return w


def build_payload(store: StatRepStore, hours: float, resolver=None,
                  extra: dict = None, catalog=None) -> dict:
    """resolver(base_call) -> (grid, approx_bool) or None, for reports whose
    own grid field is blank or invalid."""
    now = _utc_now()
    since = now - timedelta(hours=max(1.0, float(hours or 72)))
    reps, acks, alerts, lost_rows = store.query(since)

    ack_map = {}
    for tb, sid, who, ts in acks:
        ack_map.setdefault((tb, sid), []).append({'by': who, 'ts': ts})

    by_station = {}
    rows = []                 # every report, newest first -- the table view
    for r in reps:
        (rid, frm, bc, to, relay, grid, scope, sid, status, remarks, fwd, inet,
         freq, snr, srcs, ts, part) = r
        t = _parse_ts(ts)
        item = {
            'id': rid, 'call': frm, 'base': bc, 'to': to or '', 'relay': relay or '',
            'grid': grid or '', 'scope': scope or '',
            'scope_name': SCOPE_NAME.get(scope or '', scope or ''),
            'sr_id': sid or '', 'status': status, 'overall': status[0],
            'worst': worst_of(status), 'remarks': remarks or '',
            'forwarded': bool(fwd), 'internet': bool(inet), 'partial': bool(part),
            'freq': freq or 0, 'snr': snr, 'sources': (srcs or '').split(','),
            'rx_time': ts, 'age_min': int((now - t).total_seconds() // 60) if t else None,
            'acks': sorted(ack_map.get((bc, sid), []), key=lambda a: a['ts']),
        }
        by_station.setdefault(bc, []).append(item)
        rows.append(dict(item))

    plotted, unplotted = [], []
    for bc, items in by_station.items():
        latest = items[0]                          # rows are newest-first
        latest['history'] = [{'sr_id': h['sr_id'], 'rx_time': h['rx_time'],
                              'overall': h['overall'], 'status': h['status']}
                             for h in items[1:8]]
        grid, approx = latest['grid'], False
        if not grid:
            for h in items[1:]:
                if h['grid']:
                    grid = h['grid']
                    break
        if not grid and resolver:
            try:
                res = resolver(bc)
            except Exception:
                res = None
            if res and res[0]:
                grid, approx = res[0], bool(res[1])
        ll = grid_to_latlon(grid) if grid else None
        latest['plot_grid'] = grid
        latest['approx'] = approx
        if ll:
            latest['lat'], latest['lon'] = ll
            plotted.append(latest)
        else:
            unplotted.append(latest)

    sev = lambda it: (-max(_SEVERITY.get(it['overall'], 0), _SEVERITY.get(it['worst'], 0)),
                      it['age_min'] or 0)
    plotted.sort(key=sev)
    unplotted.sort(key=sev)
    # ── Heard but incomplete ──
    # (a) RRSR acks for reports we never decoded; (b) group messages whose
    # frames were lost. Matched up per station so the operator sees e.g.
    # "W8APP N21 -- lost on air, acked by W3DOF" and knows to ask for AGN.
    have = {(it['base'], it['sr_id']) for items in by_station.values() for it in items}
    lost_by = {}
    for frm, bc, to, txt, srcs, ts in lost_rows:
        lost_by.setdefault(bc, {'call': frm, 'base': bc, 'to': to, 'times': [],
                                'sources': set()})
        lost_by[bc]['times'].append(ts)
        lost_by[bc]['sources'].update((srcs or '').split(','))
    ack_only = {}
    for (tb, sid), lst in ack_map.items():
        if (tb, sid) in have:
            continue
        first = min(a['ts'] for a in lst)
        if _parse_ts(first) and _parse_ts(first) < since:
            continue
        ack_only[(tb, sid)] = {'call': tb, 'base': tb, 'sr_id': sid,
                               'acks': sorted(lst, key=lambda a: a['ts']), 'first_ack': first}
    incomplete = []
    for (tb, sid), a in sorted(ack_only.items(), key=lambda kv: kv[1]['first_ack'], reverse=True):
        t_ack = _parse_ts(a['first_ack'])
        lost_hit = None
        for ts in (lost_by.get(tb, {}).get('times') or []):
            t = _parse_ts(ts)
            if t and t_ack and 0 <= (t_ack - t).total_seconds() <= 900:
                lost_hit = ts
        if lost_hit:
            lost_by[tb]['times'].remove(lost_hit)
        incomplete.append({'kind': 'acked', 'call': a['call'], 'base': tb, 'sr_id': sid,
                           'acks': a['acks'], 'lost_at': lost_hit, 'ts': lost_hit or a['first_ack']})
    for bc, L in lost_by.items():
        if L['times']:
            incomplete.append({'kind': 'lost', 'call': L['call'], 'base': bc, 'to': L['to'],
                               'times': L['times'], 'ts': L['times'][-1],
                               'sources': sorted(s for s in L['sources'] if s)})
    incomplete.sort(key=lambda x: x['ts'], reverse=True)

    out = {
        'ts': now.strftime(_TS_FMT), 'rev': store.rev_tag, 'hours': hours, 'build': STATREP_BUILD,
        'incomplete': incomplete,
        'categories': [lbl for _k, lbl in CATEGORIES],
        'status_names': STATUS_NAME,
        'reports': plotted, 'unplotted': unplotted, 'rows': rows,
        'alerts': [{'id': a[0], 'call': a[1], 'to': a[2], 'alert_id': a[3],
                    'color': a[4], 'color_name': ALERT_COLOR.get(a[4], 'Black'),
                    'title': a[5], 'message': a[6], 'sources': (a[7] or '').split(','),
                    'rx_time': a[8]} for a in alerts[:40]],
    }
    out.update(_forms_payload(store, since, now, resolver, catalog))
    if extra:
        out.update(extra)
    return out


def _forms_payload(store, since, now, resolver, catalog) -> dict:
    """MCForms reports (decoded now, against the current form files) and the
    tagged traffic log."""
    forms = []
    for (rid, frm, bc, to, relay, fid, ans, flds, comment, dc, grid, part,
         freq, snr, srcs, ts) in store.query_forms(since):
        try:
            fields = json.loads(flds or '{}')
        except ValueError:
            fields = {}
        t = _parse_ts(ts)
        dec = decode_form(fid, ans or '', fields, catalog, sent_ref=t or now, datecode=dc or '')
        if part:
            dec['problems'].insert(0, 'frames lost on the air -- part of this report is missing')
        item = {'id': rid, 'call': frm, 'base': bc, 'to': to or '', 'relay': relay or '',
                'form_id': fid, 'title': dec['title'], 'known': dec['known'],
                'version': dec['version'], 'answers_raw': ans or '', 'answers': dec['answers'],
                'fields': dec['fields'], 'comment': comment or '', 'sent': dec['sent'],
                'problems': dec['problems'], 'partial': bool(part), 'grid': grid or '',
                'freq': freq or 0, 'snr': snr, 'sources': (srcs or '').split(','),
                'rx_time': ts, 'age_min': int((now - t).total_seconds() // 60) if t else None}
        g, approx = item['grid'], False
        if not g and resolver:
            try:
                res = resolver(bc)
            except Exception:
                res = None
            if res and res[0]:
                g, approx = res[0], True          # sender's own location, not the form's
        ll = grid_to_latlon(g) if g else None
        item['plot_grid'], item['approx'] = g, approx
        if ll:
            item['lat'], item['lon'] = ll
        forms.append(item)

    traffic, tag_counts = [], {}
    for rid, frm, to, tag, fam, text, freq, snr, ts in store.query_traffic(since):
        t = _parse_ts(ts)
        traffic.append({'id': rid, 'call': frm, 'to': to, 'tag': tag, 'family': fam,
                        'text': text, 'freq': freq or 0, 'snr': snr, 'rx_time': ts,
                        'age_min': int((now - t).total_seconds() // 60) if t else None})
        tag_counts[tag] = tag_counts.get(tag, 0) + 1
    return {'forms': forms, 'traffic': traffic, 'tag_counts': tag_counts,
            'forms_rev': FORMS_REV,
            'forms_catalog': catalog.summary() if catalog else [],
            'forms_folder': catalog.user_folder if catalog else ''}


# ── Live feed from the JS8Call TCP client ────────────────────────────────────
class StatRepSink:
    """Receives RX.DIRECTED / RX.ACTIVITY frames from JS8CallClient.

    RX.DIRECTED carries the whole message -- parse it directly.
    RX.ACTIVITY is how JS8Call reports traffic for groups you are NOT in
    (CommStat relies on the same thing). A multi-frame message can arrive in
    pieces, so frames are reassembled per audio offset for a few minutes."""

    _BUF_TTL = 240      # seconds a partial message is kept per offset
    _BUF_MAX = 600      # chars

    def __init__(self, store: StatRepStore, on_change=None, log=None):
        self.store = store
        self.on_change = on_change
        self.log = log
        self._buf = {}      # offset_bucket -> [text, last_ts]
        self._lock = threading.Lock()

    def _ingest(self, rec, freq, snr, origin):
        if rec['kind'] == 'form_request':
            return ''                    # a request carries no report -- traffic log only
        res = self.store.add(rec, _utc_now(), 'JS8Call', freq=freq, snr=snr)
        if res and origin == 'RX.ACTIVITY':
            # group traffic for groups this station is not in never reaches
            # feed_directed -- log it here so the Traffic view sees it too
            try:
                tag, fam, _l = tag_message(rec.get('raw', ''))
                self.store.add_traffic(rec['from_call'], rec.get('to_call', ''),
                                       _PREFIX_RE.sub('', rec.get('raw', ''), count=1),
                                       tag, fam, _utc_now(), freq, snr)
            except Exception:
                pass
        if res == 'new':
            if self.log:
                try:
                    k = rec['kind']
                    desc = (f"{rec['from_call']} {rec['sr_id']} {rec['status']}" if k == 'statrep'
                            else f"{rec['from_call']} ack {rec['target']},{rec['sr_id']}" if k == 'ack'
                            else f"{rec['from_call']} -> {rec['to_call']} frames lost" if k == 'lost'
                            else f"{rec['from_call']} {rec['form_id']} -> {rec['to_call']}" if k == 'form'
                            else f"{rec['from_call']} {ALERT_COLOR.get(rec['color'])}: {rec['title']}")
                    self.log('📋', 'STATREP', f'{k.upper()} ({origin}) {desc}')
                except Exception:
                    pass
            if self.on_change:
                self.on_change(rec)
        return res

    def feed_directed(self, text, from_call, to_call, freq=0.0, snr=None, cmd=''):
        lost = False
        try:
            lost = lost_frames(text)
            cl = clean_text(text)
            if has_marker(cl) or lost or has_form(cl):
                rec = parse_message(text, from_call, to_call)
                if rec:
                    self._ingest(rec, freq, snr, 'RX.DIRECTED')
        except Exception:
            pass
        # every directed message goes in the tagged traffic log
        try:
            if from_call:
                tag, fam, _l = tag_message(text, cmd, lost)
                body = clean_text(text)
                body = _PREFIX_RE.sub('', body, count=1)
                to = (to_call or '').upper()
                self.store.add_traffic(from_call.upper(), to, body, tag, fam, _utc_now(), freq, snr)
        except Exception:
            pass

    # JS8Call ends the last frame of a message with its end-of-message
    # diamond. Through the API it arrives as non-ASCII (U+2662, or mangled to
    # 'Ã\x83' and similar), so any non-ASCII at the very end means "done".
    _END_RE = re.compile(r'[^\x00-\x7f]+\s*$')
    _CALL_OR_GROUP = re.compile(r'^(@[A-Z0-9/]+|[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(?:/[A-Z0-9]{1,4})?)$')

    def _log_activity_message(self, joined, raw_tail, freq, snr, from_call):
        """Band-activity message complete -> one line in the traffic log.
        This is how QSOs between OTHER stations (not to me or my groups) are
        heard -- JS8Call only sends RX.DIRECTED for traffic addressed to me."""
        pfx, body = _strip_prefix(joined)
        sender = (pfx or from_call or '').upper()
        if not sender or not body:
            return
        if has_marker(body) or has_form(body):
            return                      # StatReps / forms are logged by _ingest
        tag, fam, _l = tag_message(body, '', lost_frames(raw_tail))
        first = body.split(' ', 1)[0].upper().rstrip(':')
        to = first if self._CALL_OR_GROUP.match(first) else ''
        self.store.add_traffic(sender, to, body, tag, fam, _utc_now(), freq, snr)

    def feed_activity(self, text, offset, freq=0.0, snr=None, from_call=''):
        try:
            raw = str(text or '')
            frag = clean_text(raw)
            if not frag:
                return
            ended = bool(self._END_RE.search(raw))
            now = time.time()
            key = int(round(float(offset or 0) / 10.0))   # ~10 Hz buckets
            flush_prev = None
            with self._lock:
                for k in [k for k, v in self._buf.items() if now - v[1] > self._BUF_TTL]:
                    del self._buf[k]
                entry = self._buf.get(key)
                prev_acc = entry[3] if entry and len(entry) > 3 else (entry[0] if entry else '')
                prev = clean_text(prev_acc)
                # Frames are joined EXACTLY as sent (no added space): JS8 splits
                # frames mid-word, so 'WORK. I' + 'T MAKES' must read 'IT MAKES'.
                frag_acc = _NON_ASCII.sub('', raw)
                # A frame that starts 'CALL: ' is the first frame of a new message;
                # so is any frame after a message already logged as complete
                # (late frames must not be glued onto a finished message).
                if _PREFIX_RE.match(frag) or not prev or (entry and entry[2] and not frag.startswith(prev)):
                    acc = frag_acc
                    # the previous message on this offset never showed its end
                    # marker -- it is over now, so log what was heard
                    if prev and entry and not entry[2] and _PREFIX_RE.match(prev) and not frag.startswith(prev):
                        flush_prev = prev
                elif frag.startswith(prev):              # cumulative value
                    acc = frag_acc
                elif prev.endswith(frag):                # repeat of the last frame
                    acc = prev_acc
                else:
                    acc = prev_acc + frag_acc
                acc = acc[-self._BUF_MAX:]
                joined = clean_text(acc)
                self._buf[key] = [joined, now, False, acc]
            if flush_prev:
                self._log_activity_message(flush_prev, '', freq, snr, from_call)

            rec = None
            if has_marker(joined) or has_form(joined):
                rec = parse_message(joined, from_call, '') or parse_message(frag, from_call, '')
                # A form heard as band activity is complete only once its trailing
                # '#XXXX' datecode has arrived; until then keep collecting frames.
                if rec and rec['kind'] == 'form' and not rec.get('datecode'):
                    rec = None
            if rec:
                with self._lock:
                    self._buf.pop(key, None)
                self._ingest(rec, freq, snr, 'RX.ACTIVITY')
                return
            if ended:
                with self._lock:
                    e = self._buf.get(key)
                    if e:
                        e[2] = True                     # logged; next prefix starts fresh
                self._log_activity_message(joined, raw, freq, snr, from_call)
        except Exception:
            pass


# ── JS8Spotter database importer ─────────────────────────────────────────────
def find_js8spotter_db() -> str:
    """Best-effort search for js8spotter.db. JS8Spotter keeps its database
    beside the program, wherever the operator unzipped/installed it."""
    home = os.path.expanduser('~')
    roots = [home, os.path.join(home, 'Desktop'), os.path.join(home, 'Documents'),
             os.path.join(home, 'Downloads'), os.path.join(home, 'OneDrive', 'Desktop'),
             os.path.join(home, 'OneDrive', 'Documents'),
             # Linux: JS8Spotter is usually unzipped or cloned into the home
             # folder or ~/Applications; some installs use ~/.local/share.
             os.path.join(home, 'Applications'), os.path.join(home, '.local', 'share'),
             os.path.join(home, 'bin'), '/opt']
    for env in ('LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)'):
        if os.environ.get(env):
            roots.append(os.environ[env])
    if os.name == 'nt':
        roots += ['C:\\', 'D:\\']
    found = []
    for r in roots:
        if not os.path.isdir(r):
            continue
        # [Jj][Ss]8 etc.: Linux file names are case-sensitive.
        for pat in ('js8spotter.db', '*[Jj][Ss]8*[Ss]potter*/js8spotter.db',
                    '*[Jj][Ss]8*[Ss]potter*/*/js8spotter.db',
                    '*[Ss]potter*/js8spotter.db', '[Jj][Ss]8[Cc]all*/js8spotter.db'):
            try:
                found += glob.glob(os.path.join(r, pat))
            except Exception:
                pass
    found = [f for f in set(found) if os.path.isfile(f)]
    if not found:
        return ''
    return max(found, key=lambda f: os.path.getmtime(f))


# Column-name candidates. JS8Spotter's 'activity' table is read by NAME, not
# position, so a JS8Spotter update that adds or reorders columns still works.
_COLS = {
    'type':  ('type', 'msg_type', 'kind'),
    'value': ('value', 'text', 'message', 'activity', 'msg'),
    'call':  ('call', 'callsign', 'from_call', 'from'),
    'time':  ('spotdate', 'timestamp', 'utc', 'datetime', 'date', 'time', 'when', 'created'),
    'dial':  ('dial', 'freq', 'frequency'),
    'snr':   ('snr', 'db'),
    'offset': ('offset',),
}


def _parse_any_time(v, local: bool):
    """JS8Spotter timestamps -> aware UTC datetime. Accepts text in common
    formats and numeric epoch seconds or milliseconds."""
    if v is None or v == '':
        return None
    try:
        f = float(v)
        if f > 1e11:
            f /= 1000.0
        if f > 1e8:
            return datetime.fromtimestamp(f, timezone.utc)
    except (TypeError, ValueError):
        pass
    s = str(v).strip().replace('T', ' ').rstrip('Z')
    s = re.sub(r'\s*UTC$', '', s)
    for fmt in ('%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M',
                '%m/%d/%Y %H:%M:%S', '%m/%d/%Y %H:%M'):
        try:
            dt = datetime.strptime(s[:26], fmt)
            if local:
                return dt.astimezone(timezone.utc)      # naive -> local -> UTC
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


class JS8SpotterImporter:
    """Polls js8spotter.db (read-only) for StatRep / alert / RRSR traffic.

    - Never writes to JS8Spotter's file. Opened with SQLite's read-only URI.
    - Remembers the highest row id it has looked at (per database path), so
      each poll only reads new rows. Changing the path starts over.
    - 'database is locked' while JS8Spotter is writing is normal; the poll is
      simply retried next interval.
    """

    POLL_SECS = 30

    def __init__(self, store: StatRepStore, on_change=None, log=None):
        self.store = store
        self.on_change = on_change
        self.log = log
        self.path = ''
        self.enabled = False
        self.local_time = False
        self.status = 'Off'
        self.last_run = ''
        self.last_counts = {}
        self._thread = None
        self._wake = threading.Event()
        self._stop = False
        self._run_lock = threading.Lock()

    def configure(self, path: str, enabled: bool, local_time: bool):
        changed = (path or '') != self.path
        self.path = path or ''
        self.enabled = bool(enabled and self.path)
        self.local_time = bool(local_time)
        if changed:
            self.status = 'Waiting for first import'
        if not self.enabled:
            self.status = 'Off' if not self.path else 'Paused'
        self.kick()

    def start(self):
        if self._thread:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True,
                                        name='JS8SpotterImporter')
        self._thread.start()

    def stop(self):
        self._stop = True
        self._wake.set()

    def kick(self):
        self._wake.set()

    def _loop(self):
        while not self._stop:
            if self.enabled:
                try:
                    self.run_once()
                except sqlite3.OperationalError as e:
                    if 'locked' in str(e).lower() or 'busy' in str(e).lower():
                        self.status = 'JS8Spotter is writing — retrying in 30 s'
                    else:
                        self.status = f'Error: {e}'
                except Exception as e:
                    self.status = f'Error: {e}'
            self._wake.wait(self.POLL_SECS)
            self._wake.clear()

    def _wm_key(self):
        return 'js8spotter_wm::' + os.path.normcase(os.path.abspath(self.path))

    @staticmethod
    def inspect(path: str) -> dict:
        """Find the activity-like table and map its columns. Raises on failure."""
        uri = 'file:' + os.path.abspath(path).replace('\\', '/') + '?mode=ro'
        with sqlite3.connect(uri, uri=True, timeout=5) as c:
            tables = [r[0] for r in c.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            best = None
            for t in sorted(tables, key=lambda n: (n.lower() != 'activity', n)):
                cols = [r[1] for r in c.execute(f'PRAGMA table_info("{t}")').fetchall()]
                low = {x.lower(): x for x in cols}
                m = {}
                for role, names in _COLS.items():
                    for n in names:
                        if n in low:
                            m[role] = low[n]
                            break
                if 'value' in m and ('time' in m or 'type' in m):
                    best = (t, m)
                    break
            if not best:
                raise RuntimeError('no activity table found (tables: %s)' % ', '.join(tables))
            total = c.execute(f'SELECT COUNT(*) FROM "{best[0]}"').fetchone()[0]
        return {'table': best[0], 'columns': best[1], 'rows': total, 'tables': tables}

    def run_once(self) -> dict:
        """Import new rows now. Safe to call from any thread."""
        if not self.path:
            self.status = 'No JS8Spotter database selected'
            return {}
        if not os.path.isfile(self.path):
            self.status = 'Not found: ' + self.path
            return {}
        with self._run_lock:
            info = self.inspect(self.path)
            t, m = info['table'], info['columns']
            q = lambda role: f'"{m[role]}"' if role in m else 'NULL'
            if self.store.get_meta('parser_rev', '') != PARSER_REV:
                with self.store._lock, self.store._connect() as _c:
                    _c.execute("DELETE FROM meta WHERE key LIKE 'js8spotter_wm::%'")
                self.store.set_meta('parser_rev', PARSER_REV)
                if self.log:
                    self.log('📋', 'SPOTTER', 'Parser updated -- re-reading JS8Spotter history')
            wm = int(self.store.get_meta(self._wm_key(), '0') or 0)
            uri = 'file:' + os.path.abspath(self.path).replace('\\', '/') + '?mode=ro'
            counts = {'scanned': 0, 'statrep': 0, 'alert': 0, 'ack': 0, 'lost': 0,
                      'form': 0, 'form_request': 0, 'dup': 0}
            cutoff = _utc_now() - timedelta(days=self.store.retention_days)
            v = q('value')
            with sqlite3.connect(uri, uri=True, timeout=5) as c:
                top = c.execute(f'SELECT MAX(rowid) FROM "{t}"').fetchone()[0] or 0
                if top < wm:          # JS8Spotter log was cleared -> start over
                    wm = 0
                rows = c.execute(
                    f'SELECT rowid, {q("type")}, {v}, {q("call")}, {q("time")}, '
                    f'{q("dial")}, {q("snr")} FROM "{t}" '
                    f'WHERE rowid > ? AND rowid <= ? AND ('
                    f"instr({v}, '{{&%') > 0 OR instr({v}, '{{F%}}') > 0 OR "
                    f"instr({v}, '{{%%') > 0 OR instr(upper({v}), ' RRSR ') > 0 OR "
                    f"instr(upper({v}), 'F!') > 0 OR "
                    f"instr({v}, '\u2026') > 0 OR instr({v}, '\u00c3') > 0) "
                    f'ORDER BY rowid', (wm, top)).fetchall()
            counts['scanned'] = top - wm
            for rowid, typ, val, call, tval, dial, snr in rows:
                rec = parse_message(val or '', call or '', '')
                if not rec:
                    continue
                when = _parse_any_time(tval, self.local_time) or _utc_now()
                if when < cutoff:
                    continue
                try:
                    f = float(dial or 0)
                    f = f * 1e6 if 0 < f < 1000 else f      # MHz -> Hz
                except (TypeError, ValueError):
                    f = 0
                try:
                    s = float(snr) if snr not in (None, '') else None
                except (TypeError, ValueError):
                    s = None
                res = self.store.add(rec, when, 'JS8Spotter', freq=f, snr=s)
                if res == 'new':
                    counts[rec['kind']] += 1
                elif res == 'dup':
                    counts['dup'] += 1
            self.store.set_meta(self._wm_key(), top)
            self.last_run = _utc_now().strftime('%H:%M:%S UTC')
            self.last_counts = counts
            new = counts['statrep'] + counts['alert'] + counts['ack'] + counts['form']
            self.status = (f"OK · {self.last_run} · {info['rows']:,} rows in "
                           f"'{t}' · {new} new")
            if new:
                if self.log:
                    self.log('📋', 'SPOTTER',
                             f"Imported {counts['statrep']} StatRep, {counts['alert']} alert, "
                             f"{counts['ack']} ack, {counts['form']} MCForms from JS8Spotter "
                             f"({counts['dup']} already had)")
                if self.on_change:
                    self.on_change(None)
            return counts

    def state(self) -> dict:
        return {'enabled': self.enabled, 'path': self.path, 'status': self.status,
                'last_run': self.last_run, 'last_counts': self.last_counts,
                'local_time': self.local_time}
