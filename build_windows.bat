@echo off
REM ===================================================================
REM  build_windows.bat  --  build the ready-to-run Windows release.
REM  Double-click it. Makes in Downloads:
REM    JS8Map_Spotter_v<ver>_build_<tag>_windows.zip   (portable, always)
REM    JS8Map_Spotter_v<ver>_build_<tag>_Setup.exe     (if Inno Setup 6 is installed)
REM  The people you send them to do NOT need Python. This PC does.
REM  All the work is in tools\build_windows.py. Must be CRLF (cmd.exe).
REM ===================================================================
title JS8Map Spotter - Windows build
cd /d "%~dp0"
set "PYEXE="
where py >nul 2>&1
if not errorlevel 1 set "PYEXE=py -3"
if not defined PYEXE (
    where python >nul 2>&1
    if not errorlevel 1 set "PYEXE=python"
)
if defined PYEXE (
    %PYEXE% -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
    if errorlevel 1 set "PYEXE="
)
if not defined PYEXE (
    echo.
    echo STOP: Python 3.8 or newer from python.org is needed on THIS PC to build.
    echo       Install it with "Add python.exe to PATH" ticked, then run this again.
    echo       The Microsoft Store "python" does not work.
    echo.
    pause
    exit /b 1
)
%PYEXE% tools\build_windows.py
echo.
pause
