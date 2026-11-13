#!/usr/bin/env python3
"""Minimal stand-in for JS8Call's TCP API, for testing without a radio.

    python3 tools/fake_js8call.py [port] [logfile]       (default 2442)

Close JS8Call first (same port). Start this, then JS8Map Spotter: it
connects as usual and receives a short script of traffic -- spots, a
CommStat StatRep, an MCForms F!104, and a two-frame QSO between other
stations heard as band activity. Everything the app sends back (e.g.
TX.SET_TEXT from a popup button) is written to the log file, so you can
see exactly what WOULD have gone to the radio. Nothing is transmitted.
Your own callsign and grid (Settings) are left as they are."""
import json, socket, sys, threading, time
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 2442
LOG = open(sys.argv[2] if len(sys.argv) > 2 else 'fake_js8call.log', 'a', buffering=1)
END = 'Ã\x83'
DIAL = 7078000
def m(t, value='', **p): return json.dumps({'type': t, 'value': value, 'params': p}) + '\n'
SCRIPT = [
    # No STATION.CALLSIGN / STATION.GRID: the app keeps the operator's own
    # callsign and grid from Settings (sending a fake grid moved the home dot).
    m('RIG.FREQ', '', DIAL=DIAL, FREQ=DIAL+1500),
    m('RX.SPOT', '', CALL='N0ASH', GRID='EN34', SNR=-7, DIAL=DIAL, OFFSET=1200, SPEED=0),
    m('RX.SPOT', '', CALL='W1AW', GRID='FN31', SNR=3, DIAL=DIAL, OFFSET=1500, SPEED=0),
    m('RX.SPOT', '', CALL='K1ABC', GRID='FN42', SNR=-12, DIAL=DIAL, OFFSET=900, SPEED=0),
    m('RX.SPOT', '', CALL='NZ1ON', GRID='FN32', SNR=-3, DIAL=DIAL, OFFSET=700, SPEED=0),
    m('RX.DIRECTED', 'N0ASH: @AMRRON ,EN34,1,B07,111111111111,ALL GOOD HERE,{&%}',
      FROM='N0ASH', TO='@AMRRON', TEXT='N0ASH: @AMRRON ,EN34,1,B07,111111111111,ALL GOOD HERE,{&%}', CMD='', SNR=-7, DIAL=DIAL, OFFSET=1200),
    m('RX.DIRECTED', 'NZ1ON: @SITREP F!104 100 #JNKO', FROM='NZ1ON', TO='@SITREP',
      TEXT='NZ1ON: @SITREP F!104 100 #JNKO', CMD='', SNR=-3, DIAL=DIAL, OFFSET=700),
    m('RX.ACTIVITY', '', TEXT='W1AW: K1ABC HOPE THE NEW RIG WORK. I', OFFSET=1500, DIAL=DIAL, SNR=3, FROM='W1AW'),
    m('RX.ACTIVITY', '', TEXT='T MAKES A DIFFERENCE ' + END, OFFSET=1502, DIAL=DIAL, SNR=3, FROM=''),
    m('RX.ACTIVITY', '', TEXT='K1ABC: W1AW RR 73' + END, OFFSET=900, DIAL=DIAL, SNR=-12, FROM='K1ABC'),
]
def serve(conn):
    def reader():
        buf = b''
        while True:
            try: d = conn.recv(4096)
            except OSError: return
            if not d: return
            buf += d
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                LOG.write('APP> ' + line.decode('utf-8', 'replace') + '\n')
    threading.Thread(target=reader, daemon=True).start()
    time.sleep(1)
    for line in SCRIPT:
        conn.sendall(line.encode('utf-8')); time.sleep(0.4)
    while True:
        time.sleep(10)
        try: conn.sendall(m('RX.SPOT', '', CALL='W1AW', GRID='FN31', SNR=2, DIAL=DIAL, OFFSET=1500).encode())
        except OSError: return
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', PORT)); s.listen(2)
LOG.write('listening\n')
while True:
    c, _ = s.accept(); LOG.write('app connected\n')
    threading.Thread(target=serve, args=(c,), daemon=True).start()
