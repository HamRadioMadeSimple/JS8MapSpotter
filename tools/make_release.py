#!/usr/bin/env python3
"""make_release.py -- build the JS8Map Spotter release zip, safely.

    python3 tools/make_release.py [output_folder] [--platform=all|windows|linux]
                                                        (default: one folder up, all)

--platform=windows / linux (2026-10-20) makes a per-OS zip, named ..._Windows.zip
or ..._Linux.zip, that leaves out the other system's scripts (below). The
program code is identical in all three; "all" is the one-zip-for-both default.

Why this exists (19c): zips used to be made by hand, and 19a/19b shipped
js8map_request_token.txt -- the secret that keeps other web pages from making
JS8Call transmit -- because a test run had left one in the app folder. This
script is now the only way a release zip is made. It:

  1. checks APP_VERSION, STATREP_BUILD and SR_PAGE_BUILD agree with each other
     and with the folder name ("Spotter Mapper Ver <APP_VERSION>");
  2. runs the unit tests (skip with --no-tests);
  3. zips the folder, LEAVING OUT operator data and personal files (the list
     below, same as .gitignore plus personal launchers);
  4. re-opens the zip and refuses to finish if any of them got in anyway.

Output: JS8Map_Spotter_Ver_<version>_build_<tag>.zip, folder inside it named
"Spotter Mapper Ver <version>", so testers unzip over the same folder and keep
their settings. Standard library only; works on Windows and Linux.
"""
import fnmatch
import os
import re
import subprocess
import sys
import zipfile

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Never shipped. Matched against each path's file name AND each folder name.
EXCLUDE_NAMES = [
    # operator data
    '*.db', '*.db-wal', '*.db-shm', '*-wal', '*-shm', '*.db-journal',
    'ham_map_config.json', 'ham_map.html', 'boot.js', 'js8_groups.json',
    'js8map_server.json', 'js8map_request_token.txt', 'js8fastchat_intent.json',
    '*.log', 'crash.log', '*.tmp',
    # build output and caches
    '__pycache__', '*.pyc', 'build', 'dist', 'pkgbuild', 'installer_output',
    'map_window_profile', '*.zip', '*.tar.gz', '.buildenv', 'output',
    # personal: launchers / folder icon that point at the developer's own paths
    'JS8Map.desktop', 'desktop.ini',
    # the git repository itself (the program folder is the repo root)
    '.git', '.github',
]
# Left out of a per-OS zip: the OTHER system's scripts and build files.
# (js8map_platform/ keeps both modules -- it picks one at import time.)
WINDOWS_ONLY = ['debug.bat', 'Build_JS8Map.bat', 'JS8Map.iss', 'JS8Map.spec', 'build_windows.bat']
LINUX_ONLY = ['debug.sh', 'build_js8map_linux.sh', 'make_js8map_package.sh',
              'JS8Map_linux.spec', 'linux_buildbox', 'install_linux_launcher.sh',
              'update_linux.sh', 'linux_install.sh', 'build_release.sh', 'build_linux.sh']

# Must never be in a zip, whatever the list above says.
FORBIDDEN = re.compile(r'(^|/)(js8map_request_token\.txt|ham_map_config\.json|[^/]*\.db(-wal|-shm)?)$')


def _excluded(rel, extra=()):
    parts = rel.replace('\\', '/').split('/')
    pats = list(EXCLUDE_NAMES) + list(extra)
    return any(fnmatch.fnmatch(p, pat) for p in parts for pat in pats)


def _read(path, pattern):
    with open(os.path.join(APP, path), encoding='utf-8') as f:
        m = re.search(pattern, f.read(), re.M)
    if not m:
        sys.exit('STOP: could not read %s from %s' % (pattern, path))
    return m.group(1)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out_dir = os.path.abspath(args[0]) if args else os.path.dirname(APP)
    plat = 'all'
    for a in sys.argv[1:]:
        if a.startswith('--platform='):
            plat = a.split('=', 1)[1].lower()
    if plat not in ('all', 'windows', 'linux'):
        sys.exit('STOP: --platform must be all, windows or linux')
    extra = LINUX_ONLY if plat == 'windows' else WINDOWS_ONLY if plat == 'linux' else []

    version = _read('js8map_runtime.py', r'^APP_VERSION\s*=\s*"([^"]+)"')
    tag_py = _read('js8map_statrep.py', r"^STATREP_BUILD\s*=\s*'([^']+)'")
    tag_js = _read('app.js', r"^const SR_PAGE_BUILD\s*=\s*'([^']+)'")
    if tag_py != tag_js:
        sys.exit('STOP: build tags differ -- STATREP_BUILD %s, SR_PAGE_BUILD %s' % (tag_py, tag_js))
    folder = 'Spotter Mapper Ver ' + version
    if os.path.basename(APP) != folder:
        print('NOTE: this folder is "%s"; the zip will still contain "%s".'
              % (os.path.basename(APP), folder))

    if '--no-tests' not in sys.argv:
        r = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests'],
                           cwd=APP, capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit('STOP: tests failed --\n' + r.stderr[-2000:])
        print('Tests:', (r.stderr.strip().splitlines() or ['?'])[-1])

    suffix = {'all': '', 'windows': '_Windows', 'linux': '_Linux'}[plat]
    name = 'JS8Map_Spotter_Ver_%s_build_%s%s.zip' % (version, tag_py, suffix)
    out = os.path.join(out_dir, name)
    left_out = []
    count = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(APP):
            rel_root = os.path.relpath(root, APP)
            dirs[:] = sorted(d for d in dirs
                             if not _excluded(os.path.normpath(os.path.join(rel_root, d)), extra))
            for fn in sorted(files):
                rel = os.path.normpath(os.path.join(rel_root, fn)).replace('\\', '/')
                if _excluded(rel, extra):
                    left_out.append(rel)
                    continue
                z.write(os.path.join(root, fn), folder + '/' + rel)
                count += 1

    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        bad = [n for n in names if FORBIDDEN.search(n)]
        linux = ['debug.sh', 'tools/install_linux_launcher.sh', 'update_linux.sh', 'linux_install.sh']
        need = {'windows': ['debug.bat'], 'linux': linux, 'all': ['debug.bat'] + linux}[plat] + ['JS8Map.py', 'app.js', 'README_TESTERS.txt']
        missing = [n for n in need if folder + '/' + n not in names]
        if missing:
            os.remove(out)
            sys.exit('STOP: the zip is missing ' + ', '.join(missing) + ', so it was deleted')
    if bad:
        os.remove(out)
        sys.exit('STOP: operator data got into the zip, so it was deleted: ' + ', '.join(bad))

    print('Left out (operator data / personal):', ', '.join(left_out) or 'nothing')
    print('Packed %d files into %s' % (count, out))


if __name__ == '__main__':
    main()
