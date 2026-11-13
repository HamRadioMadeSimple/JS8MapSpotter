"""Core regression tests for JS8Map Spotter (standard library only).

Run from the app folder:   python -m unittest discover -s tests -v

The messages below are real on-air traffic seen while building 1.1, or
close copies of it. Each test pins down a behaviour that was fixed once, so
a later change cannot quietly undo it.
"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import js8map_forms as forms        # noqa: E402
import js8map_statrep as sr         # noqa: E402

END = 'Ã\x83'          # JS8Call's end-of-message diamond as it arrives via the API


def utc(minutes_ago=0):
    return datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)


class ParseMessage(unittest.TestCase):
    def test_statrep(self):
        r = sr.parse_message('N0ASH: @AMRRON ,FM05,1,B07,111111111111,ALL GOOD,{&%}')
        self.assertEqual((r['kind'], r['from_call'], r['to_call'], r['grid'], r['sr_id']),
                         ('statrep', 'N0ASH', '@AMRRON', 'FM05', 'B07'))
        self.assertEqual(r['remarks'], 'ALL GOOD')
        self.assertFalse(r['internet'])

    def test_blank_grid_keeps_field_positions(self):
        r = sr.parse_message('N0ASH: @AMRRON ,,1,B07,+,{&%}')
        self.assertEqual((r['grid'], r['scope'], r['sr_id'], r['status']),
                         ('', '1', 'B07', '1' * 12))

    def test_doubled_prefix_and_backbone_marker(self):
        r = sr.parse_message('K7RIE: K7RIE: @MAGNET ,EM12,2,A11,123411111111,{&%3}')
        self.assertEqual(r['from_call'], 'K7RIE')
        self.assertTrue(r['internet'])

    def test_alert_and_ack(self):
        a = sr.parse_message('W1AW: @AMRRON ,A1B,2,Power Out,Grid down in county,{%%}')
        self.assertEqual((a['kind'], a['alert_id'], a['color'], a['title']),
                         ('alert', 'A1B', 2, 'Power Out'))
        k = sr.parse_message('W3DOF: @AMRRON RRSR W8APP,N21')
        self.assertEqual((k['kind'], k['target'], k['sr_id']), ('ack', 'W8APP', 'N21'))

    def test_partial_statrep_with_lost_frames(self):
        r = sr.parse_message('W8APP: @AMRRON ,FM05,1,N21,111111111111,TEXT ……')
        self.assertTrue(r['partial'])
        self.assertEqual(r['sr_id'], 'N21')

    def test_mcform_report(self):
        r = sr.parse_message('NZ1ON: @SITREP F!104 100 #JNKO')
        self.assertEqual((r['kind'], r['form_id'], r['answers'], r['datecode']),
                         ('form', 'F!104', '100', 'JNKO'))

    def test_plain_text_is_not_a_report(self):
        self.assertIsNone(sr.parse_message('K1ABC: KW3KW GM HOW ARE YOU'))


class Tagging(unittest.TestCase):
    def tag(self, text, cmd=''):
        return forms.tag_message(text, cmd)[0]

    def test_garble(self):
        self.assertEqual(self.tag('AAAAAAAA'), 'GARBLE')
        self.assertEqual(self.tag('KW3KW AAAAAAAA'), 'GARBLE')   # callsigns ignored
        self.assertFalse(forms.is_garble('599 599'))

    def test_ack_only_when_all_ack_words(self):
        self.assertEqual(self.tag('RR 73'), 'ACK')
        self.assertEqual(self.tag('TNX FOR THE QSO 73'), 'QSO')

    def test_commands(self):
        self.assertEqual(self.tag('K1ABC: KW3KW SNR -05'), 'SNR')
        self.assertEqual(self.tag('E? F!305'), 'MCF_REQ')
        self.assertEqual(self.tag('@AMRRON ,FM05,1,B07,+,{&%}', cmd='MSG'), 'CS_STATREP')


class Datecode(unittest.TestCase):
    def test_decode(self):
        d = forms.decode_datecode('#JNKO', datetime(2026, 10, 15, tzinfo=timezone.utc))
        self.assertEqual((d.month, d.day, d.hour, d.minute), (10, 14, 10, 28))

    def test_round_trip(self):
        dt = datetime(2026, 8, 9, 17, 42, tzinfo=timezone.utc)
        code = forms.encode_datecode(dt)
        back = forms.decode_datecode(code, dt + timedelta(days=60))
        self.assertEqual((back.month, back.day, back.hour, back.minute), (8, 9, 17, 42))

    def test_form_decodes_against_bundled_catalog(self):
        cat = forms.FormCatalog()
        self.assertGreaterEqual(len(cat.summary()), 34)
        r = sr.parse_message('NZ1ON: @SITREP F!104 100 #JNKO')
        dec = forms.decode_form(r['form_id'], r['answers'], r['fields'], cat)
        self.assertTrue(dec['known'])


class StoreBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = sr.StatRepStore(os.path.join(self.tmp.name, 't.db'))

    def tearDown(self):
        self.tmp.cleanup()


class Store(StoreBase):
    def test_same_report_twice_is_one(self):
        rec = sr.parse_message('N0ASH: @AMRRON ,FM05,1,B07,111111111111,OK,{&%}')
        self.assertEqual(self.store.add(rec, utc(5), 'JS8Call'), 'new')
        self.assertEqual(self.store.add(rec, utc(1), 'JS8Spotter'), 'dup')
        reps = self.store.query(utc(60))[0]
        self.assertEqual(len(reps), 1)
        self.assertEqual(reps[0][14], 'JS8Call,JS8Spotter')

    def test_rev_tag_changes_only_on_change(self):
        t0 = self.store.rev_tag
        self.assertEqual(self.store.rev_tag, t0)
        self.store.add_traffic('W1AW', 'K1ABC', 'K1ABC GM', 'QSO', 'qso', utc(1))
        self.assertNotEqual(self.store.rev_tag, t0)
        self.assertEqual(sr.build_payload(self.store, 1)['rev'], self.store.rev_tag)

    def test_traffic_extension_replaces_shorter_copy(self):
        self.store.add_traffic('W1AW', 'K1ABC', 'K1ABC GOOD MORNING HOW', 'QSO', 'qso', utc(2))
        self.store.add_traffic('W1AW', 'K1ABC', 'K1ABC GOOD MORNING HOW ARE YOU', 'QSO', 'qso', utc(1))
        rows = self.store.query_traffic(utc(60))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][5], 'K1ABC GOOD MORNING HOW ARE YOU')

    def test_qso_with_ack_attached(self):
        self.store.add_traffic('W1AW', 'KA1MF', 'KA1MF TNX FOR THE QSO', 'QSO', 'qso', utc(3))
        self.store.add_traffic('KA1MF', 'W1AW', 'W1AW RR 73', 'ACK', 'js8', utc(2))
        msgs = self.store.query_qso('KA1MF')
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]['acks'][0]['by'], 'KA1MF')
        active = self.store.query_qso_active(60)
        self.assertEqual([(p['a'], p['b']) for p in active['pairs']], [('KA1MF', 'W1AW')])

    def test_payload_shape_and_lost_frames(self):
        self.store.add(sr.parse_message('N0ASH: @AMRRON ,FM05,1,B07,111111111111,OK,{&%}'),
                       utc(5), 'JS8Call')
        self.store.add({'kind': 'lost', 'from_call': 'W8APP', 'to_call': '@AMRRON', 'text': ''},
                       utc(4), 'JS8Call')
        p = sr.build_payload(self.store, 2)
        for key in ('reports', 'rows', 'incomplete', 'alerts', 'forms', 'traffic', 'rev', 'build'):
            self.assertIn(key, p)
        self.assertEqual(p['reports'][0]['call'], 'N0ASH')
        self.assertEqual([i['kind'] for i in p['incomplete']], ['lost'])


class ActivityReassembly(StoreBase):
    """Band activity (QSOs between other stations) arrives one frame at a time."""

    def setUp(self):
        super().setUp()
        self.sink = sr.StatRepSink(self.store)

    def texts(self):
        return [r[5] for r in self.store.query_traffic(utc(60))]

    def test_frames_joined_exactly_as_sent(self):
        self.sink.feed_activity('W1AW: K1ABC HOPE THE NEW RIG WORK. I', 1500)
        self.sink.feed_activity('T MAKES A DIFFERENCE ' + END, 1502)
        self.assertEqual(self.texts(), ['K1ABC HOPE THE NEW RIG WORK. IT MAKES A DIFFERENCE'])

    def test_late_frame_does_not_double_a_logged_message(self):
        self.sink.feed_activity('J34X: W1AW 73' + END, 900)
        self.sink.feed_activity('<T J34', 901)
        self.assertEqual(self.texts(), ['W1AW 73'])

    def test_new_prefix_flushes_unfinished_message(self):
        self.sink.feed_activity('W1AW: K1ABC ARE YOU THERE', 1200)
        self.sink.feed_activity('W1AW: K1ABC HELLO AGAIN' + END, 1201)
        self.assertEqual(sorted(self.texts()), ['K1ABC ARE YOU THERE', 'K1ABC HELLO AGAIN'])

    def test_form_heard_as_activity_waits_for_datecode(self):
        self.sink.feed_activity('NZ1ON: @SITREP F!104 100', 700)
        self.assertEqual(self.store.counts()['forms'], 0)
        self.sink.feed_activity(' #JNKO' + END, 701)
        self.assertEqual(self.store.counts()['forms'], 1)


class DataFolder(unittest.TestCase):
    """A frozen Spotter must not share JS8Map 1.75's per-user folder. (17e)"""
    def test_frozen_data_folder_is_spotters_own(self):
        import js8map_runtime as rt
        with tempfile.TemporaryDirectory() as base:
            saved = {k: os.environ.get(k) for k in ('LOCALAPPDATA', 'XDG_DATA_HOME')}
            os.environ['LOCALAPPDATA'] = base
            os.environ['XDG_DATA_HOME'] = base
            sys.frozen = True
            try:
                d = rt._resolve_data_dir(base)
            finally:
                del sys.frozen
                for k, v in saved.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v
            self.assertEqual(os.path.basename(d), 'JS8Map Spotter')
            self.assertEqual(rt.DATA_FOLDER_NAME, 'JS8Map Spotter')


class MapWindowTitle(unittest.TestCase):
    """Generate Map must raise ONLY Spotter's own map window. (17f/17g)"""
    def test_exact_title_only(self):
        from js8map_platform.common import is_spotter_map_title as ok
        self.assertTrue(ok('JS8Map Spotter'))
        self.assertTrue(ok('KW3KW \u00b7 JS8Map Spotter'))
        self.assertTrue(ok('KW3KW \u00b7 JS8Map Spotter\n'))         # xdotool output
        self.assertFalse(ok('JS8Map Spotter Linux Testing - Claude'))   # the Claude app
        self.assertFalse(ok('JS8Map Spotter Linux Testing'))
        self.assertFalse(ok('KW3KW \u00b7 JS8Map'))        # JS8Map 1.75's map window
        self.assertFalse(ok('Search: JS8Map Spotter - Google Chrome'))
        self.assertFalse(ok(''))

    def test_linux_wmctrl_picks_spotter_not_175(self):
        import subprocess
        from unittest import mock
        from js8map_platform import linux
        listing = ('0x01  0 127.0.0.1__ham_map.html.Brave-browser  mint  KW3KW \u00b7 JS8Map\n'
                   '0x02  0 127.0.0.1__ham_map.html.Brave-browser  mint  KW3KW \u00b7 JS8Map Spotter\n')
        calls = []
        def fake_run(args, **kw):
            calls.append(args)
            out = listing if args[1] == '-lx' else ''
            return subprocess.CompletedProcess(args, 0, stdout=out)
        with mock.patch.object(linux.subprocess, 'run', fake_run):
            self.assertTrue(linux._raise_with_wmctrl('wmctrl'))
        self.assertEqual(calls[-1], ['wmctrl', '-i', '-a', '0x02'])


class ServerInfo(unittest.TestCase):
    """js8map_server.json tells FastChat where the live database is. (2026-10-19)"""
    def test_data_dir_points_at_the_spots_db_folder(self):
        import json as _json
        import js8map_runtime as rt
        # Importing js8map_web creates js8map_request_token.txt in DATA_DIR --
        # for a source tree that is the app folder, and a token left there got
        # zipped into 19a/19b. Remove it again if this test made it. (19c)
        tok = os.path.join(rt.DATA_DIR, rt.REQUEST_TOKEN_FILE)
        had_token = os.path.exists(tok)
        self.addCleanup(lambda: (not had_token and os.path.exists(tok)) and os.remove(tok))
        import js8map_web as web
        info = web.server_info(51234)
        self.assertEqual(info['port'], 51234)
        self.assertTrue(info['timestamp'].endswith('Z'))
        self.assertTrue(os.path.isabs(info['data_dir']))
        self.assertEqual(os.path.normcase(info['data_dir']), os.path.normcase(os.path.abspath(rt.DATA_DIR)))
        self.assertEqual(web.server_info(1, '/x/y')['data_dir'], os.path.abspath('/x/y'))
        _json.dumps(info)                                 # must stay plain JSON

if __name__ == '__main__':
    unittest.main()
