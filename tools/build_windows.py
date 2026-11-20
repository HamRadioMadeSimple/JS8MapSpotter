"""build_windows.py -- build the ready-to-run Windows release of JS8Map Spotter.

Started by build_windows.bat (double-click it). Makes, in Downloads:

  JS8Map_Spotter_v<ver>_build_<tag>_windows.zip   portable: unzip, double-click
                                                   JS8Map.exe (always made)
  JS8Map_Spotter_v<ver>_build_<tag>_Setup.exe      installer (made when Inno
                                                   Setup 6 is installed)

The people you send them to do NOT need Python: Python and Tk are inside.
Only this build PC needs Python. The first build downloads PyInstaller into a
private folder here (.buildenv): it needs the internet and a few minutes.
Never asks a question. Any problem ends with STOP: and the reason.
"""
import os, re, shutil, subprocess, sys, zipfile, glob

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(HERE)
WIN = os.name == 'nt'
TEST = os.environ.get('JS8MAP_BUILD_TEST') == '1'   # lets the logic be tested off Windows

def say(s=''): print(s, flush=True)
def stop(why):
    say(); say('STOP: ' + why); say('Nothing was sent to Downloads.')
    sys.exit(1)

def read(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read()

def grab(path, pattern):
    m = re.search(pattern, read(path), re.M)
    return m.group(1) if m else ''

# ---- 1. checks --------------------------------------------------------------------
say('JS8Map Spotter -- Windows build')
if not WIN and not TEST:
    stop('this builds the Windows program, so it must run on Windows.')
if sys.version_info < (3, 8):
    stop('Python 3.8 or newer is needed (this is %d.%d).' % sys.version_info[:2])
try:
    import tkinter  # noqa: F401
except Exception:
    stop('this Python has no Tk. Run the python.org installer again > Modify > tick "tcl/tk and IDLE".')
try:
    import venv  # noqa: F401
except Exception:
    stop('this Python has no "venv" module. Install Python from python.org.')

VERSION = grab('js8map_runtime.py', r"""^APP_VERSION\s*=\s*['"]([^'"]+)['"]""")
TAG_PY = grab('js8map_statrep.py', r"^STATREP_BUILD\s*=\s*'([^']+)'")
TAG_JS = grab('app.js', r"^const SR_PAGE_BUILD\s*=\s*'([^']+)'")
ISS_VER = grab('JS8Map.iss', r'^#define\s+MyAppVersion\s+"([^"]+)"') or grab('JS8Map.iss', r'^AppVersion=(\S+)')
say('  folder:   ' + HERE)
say('  version:  %s   build: %s' % (VERSION or '?', TAG_PY or '?'))
if not VERSION or not TAG_PY:
    stop('could not read the version or the build tag.')
if TAG_PY != TAG_JS:
    stop('the two build tags differ (%s / %s). Make STATREP_BUILD in js8map_statrep.py\n'
         '      and SR_PAGE_BUILD in app.js the same.' % (TAG_PY, TAG_JS))
if ISS_VER and ISS_VER != VERSION:
    stop('JS8Map.iss says version %s, but the program is %s.' % (ISS_VER, VERSION))

# Every file the installer copies must exist (the list comes from JS8Map.iss itself).
ISS_FILES = re.findall(r'^Source:\s*"([^"]+)";\s*DestDir:\s*"\{app\}"', read('JS8Map.iss'), re.M)
NEED = ['JS8Map.py', 'JS8Map.spec', 'index.html', 'app.js', 'app.css'] + \
       [f for f in ISS_FILES if not f.startswith('dist')]
missing = [f for f in NEED if not os.path.exists(f)]
if missing:
    stop('missing file(s) in this folder: ' + ', '.join(missing))
if not glob.glob(os.path.join('forms', 'MCF*.txt')):
    stop('the forms folder has no MCF*.txt files.')
APP_FILES = [f for f in ISS_FILES if not f.startswith('dist')]   # beside JS8Map.exe

DL = os.path.join(os.path.expanduser('~'), 'Downloads')
os.makedirs(DL, exist_ok=True)
ZIPNAME = 'JS8Map_Spotter_v%s_build_%s_windows.zip' % (VERSION, TAG_PY)
SETUPNAME = 'JS8Map_Spotter_v%s_build_%s_Setup.exe' % (VERSION, TAG_PY)
for n in (ZIPNAME, SETUPNAME):
    if os.path.exists(os.path.join(DL, n)):
        stop('%s is already in Downloads.\n'
             '      Raise the letter in BOTH build tags, or delete that file if it was a failed try.' % n)
OUT = os.path.join(HERE, 'output'); os.makedirs(OUT, exist_ok=True)
LOG = os.path.join(OUT, 'build_windows.log')
log = open(LOG, 'w', encoding='utf-8')
say('  log:      ' + LOG); say()

def run(cmd, what):
    log.write('\n$ ' + ' '.join(cmd) + '\n'); log.flush()
    r = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        log.close()
        tail = read(LOG).splitlines()[-25:]
        say('\n'.join('      ' + t for t in tail))
        stop(what + ' failed (above; full log: %s)' % LOG)

# ---- 2. build tools (once) ------------------------------------------------------------
say('[1/4] build tools ...')
ENV = os.path.join(HERE, '.buildenv')
PY = os.path.join(ENV, 'Scripts', 'python.exe') if WIN else os.path.join(ENV, 'bin', 'python')
def has_pyinstaller():
    return os.path.exists(PY) and subprocess.run([PY, '-c', 'import PyInstaller, tkinter'],
                                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
if not has_pyinstaller():
    say('      first time: downloading PyInstaller (a few minutes)')
    shutil.rmtree(ENV, ignore_errors=True)
    run([sys.executable, '-m', 'venv', ENV], 'making .buildenv')
    run([PY, '-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'], 'updating pip')
    run([PY, '-m', 'pip', 'install', '--quiet', 'pyinstaller'], 'downloading PyInstaller (check the internet)')
    if not has_pyinstaller():
        shutil.rmtree(ENV, ignore_errors=True); stop('PyInstaller did not install correctly. Run this again.')
say('      ready')

# ---- 3. the program -------------------------------------------------------------------
say('[2/4] building JS8Map.exe (1-3 minutes) ...')
for d in ('build', 'dist'):
    shutil.rmtree(d, ignore_errors=True)
run([PY, '-m', 'PyInstaller', 'JS8Map.spec', '--clean', '--noconfirm'], 'the program build')
EXE = os.path.join('dist', 'JS8Map.exe' if WIN else 'JS8Map')
if not os.path.exists(EXE):
    stop('the build finished but %s is missing (see %s)' % (EXE, LOG))
for f in APP_FILES:
    shutil.copy2(f, 'dist')
say('      %s  %.0f MB' % (EXE, os.path.getsize(EXE) / 1e6))

# ---- 4. portable zip ----------------------------------------------------------------
say('[3/4] portable zip ...')
BAD = re.compile(r'(js8map_request_token\.txt|ham_map_config\.json|\.db(-wal|-shm)?|boot\.js|ham_map\.html)$', re.I)
inner = 'JS8Map Spotter %s' % VERSION
zpath = os.path.join(OUT, ZIPNAME)
with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in [os.path.basename(EXE)] + [os.path.basename(a) for a in APP_FILES]:
        z.write(os.path.join('dist', f), inner + '/' + f)
    z.writestr(inner + '/README.txt',
        'JS8Map Spotter %s (build %s)\r\n\r\n'
        'Double-click JS8Map.exe to start. Keep all the files in this folder together.\r\n'
        'Your settings are kept in %%LOCALAPPDATA%%\\JS8Map Spotter, so a newer build\r\n'
        'can be unzipped over this folder.\r\n' % (VERSION, TAG_PY))
with zipfile.ZipFile(zpath) as z:
    bad = [n for n in z.namelist() if BAD.search(n)]
if bad:
    os.remove(zpath); stop('the zip contained operator data (%s) -- it was deleted.' % ', '.join(bad))
shutil.copy2(zpath, os.path.join(DL, ZIPNAME))
say('      ' + ZIPNAME)

# ---- 5. installer (if Inno Setup is installed) ----------------------------------------
say('[4/4] installer ...')
ISCC = ''
for c in (r'C:\Program Files (x86)\Inno Setup 6\ISCC.exe', r'C:\Program Files\Inno Setup 6\ISCC.exe',
          os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'Inno Setup 6', 'ISCC.exe')):
    if c and os.path.exists(c):
        ISCC = c; break
made_setup = False
if not ISCC:
    say('      skipped: Inno Setup 6 is not installed (free from jrsoftware.org/isdl.php).')
    say('      The portable zip is complete without it.')
else:
    shutil.rmtree('installer_output', ignore_errors=True)
    run([ISCC, '/Qp', 'JS8Map.iss'], 'Inno Setup')
    built = glob.glob(os.path.join('installer_output', '*.exe'))
    if not built:
        stop('Inno Setup finished but made no .exe (see %s)' % LOG)
    shutil.copy2(built[0], os.path.join(OUT, SETUPNAME))
    shutil.copy2(built[0], os.path.join(DL, SETUPNAME))
    made_setup = True
    say('      ' + SETUPNAME)

shutil.rmtree('build', ignore_errors=True)
log.close()
say()
say('DONE.  The file(s) to send are in your Downloads folder:')
say('  ' + ZIPNAME + '   (portable: unzip, double-click JS8Map.exe)')
if made_setup:
    say('  ' + SETUPNAME + '   (installer: double-click, Next, Install)')
say('Nobody needs Python to run them. Copies are also in ' + OUT)
