@echo off
REM ===================================================================
REM  debug.bat  --  Run JS8Map Spotter FROM SOURCE (not the frozen .exe).
REM
REM  The dist\JS8Map.exe is a FROZEN snapshot; it does not read the .py
REM  files here. Run THIS to test code changes, then rebuild with
REM  Build_JS8Map.bat and test the exe too.
REM
REM  A source run keeps its settings and databases in THIS folder.
REM  The installed exe uses %LOCALAPPDATA%\JS8Map Spotter instead.
REM
REM  Python: uses the "py" launcher (python.org installs it), otherwise
REM  "python" on PATH. To use a particular Python, first run
REM      set "PYEXE=C:\Path\To\python.exe"
REM  in the same Command Prompt, then debug.bat.
REM  Must be CRLF (cmd.exe).
REM ===================================================================
cd /d "%~dp0"
if defined PYEXE if exist "%PYEXE%" goto run
where py >nul 2>&1
if not errorlevel 1 (
    set "PYEXE=py"
    goto run
)
set "PYEXE=python"
:run
echo Using Python: %PYEXE%
"%PYEXE%" JS8Map.py
echo.
echo === JS8Map Spotter exited. Close this window or press a key. ===
pause
