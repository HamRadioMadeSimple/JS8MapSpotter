#!/usr/bin/env python3
"""
js8map_forms.py  --  MCForms catalog / decoder and JS8Call message tagger.

MCFORMS ON THE AIR
==================
MCForms (JS8Spotter "micro forms", maintained by SitRepNet.com / KN4AM) send
one compact line; the form file itself never goes over the air:

    F!<id> <answers><fields> <comment> #<datecode>
    e.g.  F!301 143132111 #ABCD
          F!309 DS[TREE DOWN]GR[EM79UR]14341 #JNOC

  * every '?' question in the form file is answered by ONE character, in order
  * every '[XX]' prompt comes back as  XX[typed text]
  * '#MDHm' datecode: month A-L, day A-Z then 0-4 (1-31), hour A-X (0-23),
    minute A-Z then 0-3 in 2-minute steps
  * 'E? F!305' is somebody ASKING a station for its F!305 -- not a report

FORM FILES
==========
Read from 'forms' folders, later folders overriding earlier ones:
    1. the copy bundled with the program (APP_DIR/forms)
    2. a 'forms' folder beside JS8Map.exe        (EXE_DIR/forms)
    3. the data folder   %LOCALAPPDATA%\\JS8Map Spotter\\forms   (DATA_DIR/forms)
Drop a new or revised MCF*.txt into (3) and it is used within 30 s -- no
rebuild. Reports are stored RAW and decoded when shown, so a newer form file
re-decodes reports already stored.

TAGGING
=======
tag_message() gives every message one tag (CommStat / MCForms / JS8Call
command / plain text) for the traffic log.

Leaf module: stdlib only. Never transmits.
"""
from __future__ import annotations

import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

FORMS_REV = '2026-10-14a'

# ── Text clean-up (same rules as js8map_statrep.clean_text) ──────────────────
_NON_ASCII = re.compile(r'[^ -~]+')
_SPACES = re.compile(r'\s+')


def _clean(s) -> str:
    s = str(s or '').replace('∅', '0')          # JS8Call slashed zero
    s = _NON_ASCII.sub(' ', s)                        # end-of-message diamond etc.
    return _SPACES.sub(' ', s).strip()


# ═════════════════════════════════════════════════════════════════════════════
#  Form files
# ═════════════════════════════════════════════════════════════════════════════
_TITLE_RE = re.compile(r'^(.*)\|\s*(F![0-9A-Z]{3}[A-Z]?)\s*$', re.I)
_PROMPT_RE = re.compile(r'^\[([0-9A-Z]{2})\]\s*(.*)$', re.I)
_OPTION_RE = re.compile(r'^@([0-9A-Z])\s?(.*)$', re.I)
_VERSION_RE = re.compile(
    r'(?:version|updated|revised|revision|published|created|date)\D{0,12}'
    r'(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})', re.I)


def _read_text(path: str) -> str:
    with open(path, 'rb') as f:
        raw = f.read()
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return raw.decode('cp1252', errors='replace')


def parse_form(text: str, path: str = ''):
    """Parse one MCForms .txt file into a dict, or None if line 1 is not
    'Title|F!xxx' (readme / notes files are skipped that way)."""
    lines = (text or '').splitlines()
    if not lines:
        return None
    m = _TITLE_RE.match(lines[0].strip())
    if not m:
        return None
    form = {'id': m.group(2).upper(), 'title': m.group(1).strip(), 'version': '',
            'questions': [], 'prompts': [], 'path': path}
    section, cur = '', None
    for raw in lines[1:]:
        line = raw.strip()
        if not line:
            continue
        head = line[0]
        if head in '#.':
            if not form['version']:
                v = _VERSION_RE.search(line)
                if v:
                    form['version'] = v.group(1)
            continue
        if head == '!':
            section = line.lstrip('!').strip() or section
            cur = None
        elif head == '?':
            cur = {'q': line[1:].strip(), 'section': section, 'options': {}, 'default': ''}
            form['questions'].append(cur)
        elif head == '@':
            om = _OPTION_RE.match(line)
            if om and cur is not None:
                code, ans = om.group(1).upper(), om.group(2).strip()
                if ans.startswith('*'):              # '*' marks the form's default
                    ans = ans[1:].strip()
                    cur['default'] = cur['default'] or code
                cur['options'].setdefault(code, ans)  # duplicated code: first wins
        elif head == '[':
            pm = _PROMPT_RE.match(line)
            if pm:
                form['prompts'].append({'code': pm.group(1).upper(),
                                        'label': pm.group(2).strip().rstrip(':').strip(),
                                        'section': section})
                cur = None
        # anything else (stray notes, divider lines) is ignored, as JS8Spotter does
    return form


def default_folders():
    """[bundled, beside-exe, data] forms folders (existing or not)."""
    try:
        from js8map_runtime import APP_DIR, EXE_DIR, DATA_DIR
    except Exception:
        here = os.path.dirname(os.path.abspath(__file__))
        APP_DIR = EXE_DIR = DATA_DIR = here
    out = []
    for d in (APP_DIR, EXE_DIR, DATA_DIR):
        p = os.path.join(d, 'forms')
        if os.path.normcase(os.path.abspath(p)) not in [os.path.normcase(os.path.abspath(x)) for x in out]:
            out.append(p)
    return out


class FormCatalog:
    """All known forms, keyed 'F!309'. Thread-safe; rescans its folders at
    most every RESCAN_S seconds when something in them changed."""

    RESCAN_S = 30

    def __init__(self, folders=None):
        self.folders = list(folders) if folders else default_folders()
        self.forms = {}
        self.errors = []
        self._sig = None
        self._checked = 0.0
        self._lock = threading.Lock()
        self.reload()

    @property
    def user_folder(self) -> str:
        """Where the operator drops new forms (the last folder)."""
        return self.folders[-1]

    def _signature(self):
        sig = []
        for d in self.folders:
            try:
                for n in sorted(os.listdir(d)):
                    if n.lower().endswith('.txt'):
                        sig.append((d, n, os.path.getmtime(os.path.join(d, n))))
            except OSError:
                pass
        return tuple(sig)

    def reload(self):
        forms, errors = {}, []
        for d in self.folders:
            if not os.path.isdir(d):
                continue
            for n in sorted(os.listdir(d)):
                if not n.lower().endswith('.txt'):
                    continue
                p = os.path.join(d, n)
                try:
                    f = parse_form(_read_text(p), p)
                except Exception as e:
                    errors.append(f'{n}: {e}')
                    continue
                if f:
                    forms[f['id']] = f
        with self._lock:
            self.forms, self.errors = forms, errors
            self._sig = self._signature()
            self._checked = time.time()
        return len(forms)

    def _maybe_rescan(self):
        if time.time() - self._checked < self.RESCAN_S:
            return
        self._checked = time.time()
        if self._signature() != self._sig:
            self.reload()

    def get(self, form_id: str):
        self._maybe_rescan()
        with self._lock:
            return self.forms.get((form_id or '').upper())

    def summary(self):
        self._maybe_rescan()
        with self._lock:
            fs = sorted(self.forms.values(), key=lambda f: f['id'])
        return [{'id': f['id'], 'title': f['title'], 'version': f['version'],
                 'questions': len(f['questions']), 'fields': len(f['prompts']),
                 'has_grid': any(p['code'] == 'GR' for p in f['prompts'])} for f in fs]


# ═════════════════════════════════════════════════════════════════════════════
#  Datecode
# ═════════════════════════════════════════════════════════════════════════════
_L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
_DAY = _L + '01234'           # 1..31
_MIN = _L + '0123'            # 0..58 step 2


def decode_datecode(code: str, ref: datetime = None):
    """'#CJIB' -> aware UTC datetime (year = the one nearest before ref)."""
    code = (code or '').lstrip('#').upper()
    if len(code) != 4:
        return None
    mo, dy, hr, mi = code
    if mo not in _L[:12] or dy not in _DAY or hr not in _L[:24] or mi not in _MIN:
        return None
    ref = ref or datetime.now(timezone.utc)
    for year in (ref.year, ref.year - 1):
        try:
            dt = datetime(year, _L.index(mo) + 1, _DAY.index(dy) + 1, _L.index(hr),
                          _MIN.index(mi) * 2, tzinfo=timezone.utc)
        except ValueError:
            continue
        if dt <= ref + timedelta(days=1):
            return dt
    return None


def encode_datecode(dt: datetime) -> str:
    return '#' + _L[dt.month - 1] + _DAY[dt.day - 1] + _L[dt.hour] + _MIN[dt.minute // 2]


# ═════════════════════════════════════════════════════════════════════════════
#  Form responses
# ═════════════════════════════════════════════════════════════════════════════
_FORM_ID_RE = re.compile(r'(?<![0-9A-Z])F!([0-9A-Z]{3}[A-Z]?)(?=\s|$)')
_DATECODE_RE = re.compile(r'(?:^|\s)#([A-L][A-Z0-4][A-X][A-Z0-3])\s*$')
_FIELD_RE = re.compile(r'([0-9A-Z]{2})\[([^\]]*)(\]|$)')
_PREFIX_RE = re.compile(r'^([A-Z0-9/]{3,}):\s*')
GRID_RE = re.compile(r'^[A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2}(?:[A-X]{2})?)?)?$')


def has_form(text: str) -> bool:
    return 'F!' in (text or '').upper()


def _split_body(body: str):
    """'14341 GR[EM79] HELLO' -> ('14341', {'GR': 'EM79'}, 'HELLO').
    Fields may come before or after the answers, with or without spaces."""
    answers, fields, pos, n, got = '', {}, 0, len(body), False
    while pos < n:
        while pos < n and body[pos] == ' ':
            pos += 1
        if pos >= n:
            break
        fm = _FIELD_RE.match(body, pos)
        if fm:
            fields[fm.group(1)] = fm.group(2).strip()
            pos = fm.end()
            continue
        m = re.match(r'[0-9A-Z]+', body[pos:])
        if m and not got:
            run, end = m.group(0), pos + len(m.group(0))
            if end < n and body[end] == '[' and len(run) >= 2:   # '14341GR[...]'
                answers += run[:-2]
                pos = end - 2
                continue
            answers += run
            pos, got = end, True
            continue
        break
    return answers, fields, body[pos:].strip()


def parse_form_message(text: str, from_call: str = '', to_call: str = ''):
    """Find an MCForms report or request in one JS8Call message.

    Returns None, or {'kind': 'form' | 'form_request', ...} with the RAW parts
    (decoding happens later, against the current form files)."""
    raw = _clean(text).upper()
    if 'F!' not in raw:
        return None
    sender = (from_call or '').upper().strip()
    body = raw
    m = _PREFIX_RE.match(body)
    if m:
        sender = m.group(1)
        body = body[m.end():]
        m2 = _PREFIX_RE.match(body)                       # doubled-prefix bug
        if m2 and m2.group(1).split('/')[0] == sender.split('/')[0]:
            body = body[m2.end():]
    fm = _FORM_ID_RE.search(body)
    if not fm or not sender:
        return None
    before = body[:fm.start()].strip()
    to = (before.split()[0] if before else (to_call or '')).upper()
    form_id = 'F!' + fm.group(1)
    rest = body[fm.end():]
    if re.search(r'(^|\s)E\?$', before):
        return {'kind': 'form_request', 'from_call': sender, 'to_call': to if to != 'E?' else (to_call or '').upper(),
                'form_id': form_id, 'raw': raw[:300]}
    dc = ''
    dm = _DATECODE_RE.search(rest)
    if dm:
        dc = dm.group(1)
        rest = rest[:dm.start()]
    answers, fields, comment = _split_body(rest)
    if not answers and not fields:
        return None                                      # just a mention of a form number
    grid = fields.get('GR', '').strip().upper()
    return {'kind': 'form', 'from_call': sender, 'to_call': to, 'form_id': form_id,
            'answers': answers[:120], 'fields': {k: v[:120] for k, v in fields.items()},
            'comment': comment[:200], 'datecode': dc,
            'grid': grid if GRID_RE.match(grid) else '', 'raw': raw[:500]}


def decode_form(form_id: str, answers: str, fields: dict, catalog, sent_ref=None,
                datecode: str = ''):
    """Decode stored parts against the form file. Always returns a dict."""
    form = catalog.get(form_id) if catalog else None
    out = {'known': bool(form), 'title': form['title'] if form else '',
           'version': form['version'] if form else '', 'answers': [], 'fields': [],
           'problems': [], 'sent': ''}
    if datecode:
        dt = decode_datecode(datecode, sent_ref)
        if dt:
            out['sent'] = dt.strftime('%Y-%m-%d %H:%M:%S')
    labels = {p['code']: p['label'] for p in (form['prompts'] if form else [])}
    order = [p['code'] for p in (form['prompts'] if form else [])]
    for code in order + [c for c in fields if c not in order]:
        if code in fields:
            out['fields'].append({'code': code, 'label': labels.get(code, code), 'value': fields[code]})
    if not form:
        out['problems'].append(f'{form_id} is not in the forms folder -- answers cannot be decoded')
        return out
    qs = form['questions']
    for i, q in enumerate(qs):
        c = answers[i] if i < len(answers) else ''
        if not c:
            a, ok = 'not received', False
        elif c in q['options']:
            a, ok = q['options'][c], True
        else:
            a, ok = f'code {c} is not on this form', False
        out['answers'].append({'q': q['q'], 'section': q['section'], 'code': c, 'a': a, 'ok': ok})
    if len(answers) < len(qs):
        out['problems'].append(f'{len(answers)} of {len(qs)} answers received -- cut short, '
                               f'or the sender has a different version of this form')
    elif len(answers) > len(qs):
        out['problems'].append(f'{len(answers)} answers for {len(qs)} questions -- the sender '
                               f'probably has a newer version of this form')
    bad = [a['code'] for a in out['answers'] if a['code'] and not a['ok']]
    if bad:
        out['problems'].append('answer code(s) not on this form: ' + ' '.join(bad))
    extra = [c for c in fields if c not in labels]
    if extra:
        out['problems'].append('field(s) not on this form: ' + ' '.join(extra))
    return out


# ═════════════════════════════════════════════════════════════════════════════
#  Message tagging
# ═════════════════════════════════════════════════════════════════════════════
# (family, tag, label). Families: commstat, mcforms, query, js8, text.
TAGS = {
    'CS_STATREP':  ('commstat', 'CommStat StatRep'),
    'CS_ALERT':    ('commstat', 'CommStat Alert'),
    'CS_ACK':      ('commstat', 'CommStat ack (RRSR)'),
    'CS_OTHER':    ('commstat', 'CommStat (other)'),
    'MCF':         ('mcforms',  'MCForms report'),
    'MCF_REQ':     ('mcforms',  'MCForms request (E?)'),
    'EXPECT':      ('mcforms',  'Expect query (E?)'),
    'LOST':        ('js8',      'Frames lost'),
    'HEARTBEAT':   ('js8',      'Heartbeat'),
    'HB_REPLY':    ('js8',      'Heartbeat reply'),
    'CQ':          ('js8',      'CQ'),
    'SNR':         ('js8',      'SNR report'),
    'GRID':        ('js8',      'Grid'),
    'INFO':        ('js8',      'Info'),
    'STATUS':      ('js8',      'Status'),
    'HEARING':     ('js8',      'Hearing list'),
    'MSG':         ('js8',      'Stored message'),
    'APRS':        ('js8',      'APRS'),
    'RELAY':       ('js8',      'Relay'),
    'ACK':         ('js8',      'Ack / RR / 73'),
    'QUERY':       ('query',    'Query'),
    'QSO':         ('qso',      'QSO message'),   # typed conversation text
    'GARBLE':      ('js8',      'Decode garble'), # 'AAAAAAAA' and similar decode junk
    'TEXT':        ('text',     'Text'),
}


# ── QSO text vs decode garble ────────────────────────────────────────────────
# JS8Call sometimes decodes noise as long runs of one letter ('AAAAAAAAA',
# 'EEEEEE'). Those are not messages. Callsigns and @groups are ignored when
# judging, so 'KW3KW AAAAAAAA' is still garble.
_CALLISH = re.compile(r'(^|\s)(@[A-Z0-9/]+|(?=[A-Z0-9/]*[A-Z])[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(?:/[A-Z0-9]{1,4})?:?)(?=\s|$)')
_RUN5 = re.compile(r'([A-Z0-9])\1{4,}')


def message_words(text: str) -> str:
    """The typed part of a message: callsigns, @groups and punctuation removed."""
    body = _CALLISH.sub(' ', ' ' + _clean(text).upper() + ' ')
    return _SPACES.sub(' ', body).strip()


def is_garble(text: str) -> bool:
    words = message_words(text)
    chars = re.sub(r'[^A-Z0-9]', '', words)
    if not chars:
        return False
    if _RUN5.search(chars):
        return True
    letters = re.sub(r'[^A-Z]', '', chars)          # '599 599' is a report, not garble
    if len(letters) >= 6:
        top = max(letters.count(ch) for ch in set(letters))
        if top / len(letters) >= 0.6:
            return True
    return False


def is_qso_text(text: str) -> bool:
    """Real typed words, not just callsigns and not garble."""
    w = message_words(text)
    return len(re.sub(r'[^A-Z0-9]', '', w)) >= 2 and not is_garble(text)

# JS8Call's own CMD parameter (RX.DIRECTED) -> tag. Exact, so used first.
_CMD_TAG = {
    'HEARTBEAT': 'HEARTBEAT', 'HEARTBEAT SNR': 'HB_REPLY', 'CQ': 'CQ',
    'SNR': 'SNR', 'SNR?': 'QUERY', 'GRID': 'GRID', 'GRID?': 'QUERY',
    'INFO': 'INFO', 'INFO?': 'QUERY', 'STATUS': 'STATUS', 'STATUS?': 'QUERY',
    'HEARING': 'HEARING', 'HEARING?': 'QUERY', 'MSG': 'MSG', 'MSG TO:': 'MSG',
    'MSGS': 'MSG', 'QUERY': 'QUERY', 'QUERY MSGS': 'QUERY', 'QUERY CALL': 'QUERY',
    'QUERY MSG': 'QUERY', 'AGN?': 'QUERY', 'QSL?': 'QUERY', 'HW CPY?': 'QUERY',
    'ACK': 'ACK', 'RR': 'ACK', '73': 'ACK', 'QSL': 'ACK', 'FB': 'ACK', 'SK': 'ACK',
    'NACK': 'ACK', 'YES': 'ACK', 'NO': 'ACK', '>': 'RELAY', 'APRS:': 'APRS',
}

_TEXT_RULES = [
    ('CS_STATREP', re.compile(r'\{(&%3?|F%)\}')),
    ('CS_ALERT',   re.compile(r'\{%%3?\}')),
    ('CS_ACK',     re.compile(r'(^|\s)RRSR\s')),
    ('CS_OTHER',   re.compile(r'\{[^\s{}]{1,3}\}')),
    ('MCF_REQ',    re.compile(r'(^|\s)E\?\s+F![0-9A-Z]{3}')),
    ('MCF',        _FORM_ID_RE),
    ('EXPECT',     re.compile(r'(^|\s)E\?\s+\S')),
    ('HB_REPLY',   re.compile(r'(^|\s)HEARTBEAT\s+SNR\b')),
    ('HEARTBEAT',  re.compile(r'(^|\s)(@HB\b|HEARTBEAT\b)')),
    ('CQ',         re.compile(r'(^|\s)(@ALLCALL\s+)?CQ\b')),
    ('APRS',       re.compile(r'@APRSIS\b|(^|\s)APRS:')),
    ('MSG',        re.compile(r'(^|\s)MSG(\s+TO:)?\s')),
    ('QUERY',      re.compile(r'(^|\s)(SNR|GRID|INFO|STATUS|HEARING|AGN|QSL)\?|(^|\s)QUERY\b')),
    ('SNR',        re.compile(r'(^|\s)SNR\s+[+-]?\d')),
    ('GRID',       re.compile(r'(^|\s)GRID\s+[A-R]{2}\d\d')),
    ('INFO',       re.compile(r'(^|\s)INFO\s')),
    ('STATUS',     re.compile(r'(^|\s)STATUS\s')),
    ('HEARING',    re.compile(r'(^|\s)HEARING\s')),
    ('RELAY',      re.compile(r'[A-Z0-9]>\s?[A-Z0-9@]')),
]
# An ack is a message made ONLY of ack words ('RR 73', 'TNX 73'); a typed
# sentence that happens to end in 73 is a QSO message.
_ACK_WORDS = {'ACK', 'RR', 'RRR', '73', '88', 'QSL', 'FB', 'SK', 'TU', 'TNX', 'TKS', 'GL', 'GN', 'OK', 'R'}


def tag_message(text: str, cmd: str = '', lost: bool = False):
    """-> (tag, family, label). CommStat / MCForms markers in the text win over
    JS8Call's CMD (a StatRep rides in an ordinary directed message)."""
    raw = _clean(text).upper()
    body = _PREFIX_RE.sub('', raw, count=1)
    for tag, rx in _TEXT_RULES[:7]:                   # CommStat + MCForms first
        if rx.search(body):
            return tag, TAGS[tag][0], TAGS[tag][1]
    if lost:
        return 'LOST', 'js8', TAGS['LOST'][1]
    c = (cmd or '').strip().upper()
    if c in _CMD_TAG:
        t = _CMD_TAG[c]
        return t, TAGS[t][0], TAGS[t][1]
    for tag, rx in _TEXT_RULES[7:]:
        if rx.search(body):
            return tag, TAGS[tag][0], TAGS[tag][1]
    words = message_words(body).replace(',', ' ').replace('.', ' ').split()
    if words and all(w in _ACK_WORDS for w in words):
        return 'ACK', 'js8', TAGS['ACK'][1]
    if is_garble(body):
        return 'GARBLE', 'js8', TAGS['GARBLE'][1]
    if is_qso_text(body):
        return 'QSO', 'qso', TAGS['QSO'][1]
    return 'TEXT', 'text', TAGS['TEXT'][1]


# ── CLI:  python js8map_forms.py [--forms DIR] [--catalog] ["message"] ──────
if __name__ == '__main__':
    import argparse
    import json
    ap = argparse.ArgumentParser(description='Decode MCForms / tag JS8Call messages')
    ap.add_argument('--forms', action='append', help='forms folder (repeatable)')
    ap.add_argument('--catalog', action='store_true')
    ap.add_argument('message', nargs='*')
    a = ap.parse_args()
    cat = FormCatalog(a.forms)
    for e in cat.errors:
        print('!', e)
    if a.catalog:
        for f in cat.summary():
            print(f"{f['id']:8} {f['title']}  ({f['questions']} q, {f['fields']} fields"
                  f"{', grid' if f['has_grid'] else ''})")
    if a.message:
        msg = ' '.join(a.message)
        print(tag_message(msg))
        r = parse_form_message(msg)
        print(json.dumps(r, indent=1))
        if r and r['kind'] == 'form':
            print(json.dumps(decode_form(r['form_id'], r['answers'], r['fields'], cat,
                                         datecode=r['datecode']), indent=1))
