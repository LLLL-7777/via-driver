@echo off
rem =====================================================================
rem  via-driver launcher
rem  This file is intentionally pure ASCII. cmd.exe on a Chinese Windows
rem  runs at code page 936; any non-ASCII byte inside a .bat can be
rem  mis-parsed and break paths. All Chinese messages live in launcher.py.
rem =====================================================================
setlocal enabledelayedexpansion
chcp 65001 >nul
set "PYTHONUTF8=1"
cd /d "%~dp0"

set "PY="
set "PYARGS="

rem --- 1) WorkBuddy bundled interpreter -------------------------------
rem On this machine this is the ONLY working python: the bare "python"
rem command resolves to a 0-byte Microsoft Store stub.
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\python\versions\*") do (
    if exist "%%D\python.exe" set "PY=%%D\python.exe"
)

rem --- 2) python.org installs (per-user) ------------------------------
if not defined PY (
    for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if exist "%%D\python.exe" set "PY=%%D\python.exe"
    )
)

rem --- 3) python.org installs (machine-wide) --------------------------
if not defined PY (
    for /d %%D in ("C:\Python3*") do (
        if exist "%%D\python.exe" set "PY=%%D\python.exe"
    )
)

rem --- 4) py launcher -------------------------------------------------
if not defined PY (
    where py >nul 2>nul
    if not errorlevel 1 (
        set "PY=py"
        set "PYARGS=-3"
    )
)

if not defined PY goto nopython

rem --- 5) make sure a build exists ------------------------------------
if not exist "dist\index.html" (
    echo.
    echo [via-driver] dist\index.html not found.
    echo Run this once in the project folder first:
    echo     npm run build
    echo.
    pause
    exit /b 1
)

echo [via-driver] python: "%PY%" %PYARGS%
"%PY%" %PYARGS% "launcher.py"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo [via-driver] launcher exited with code %RC%
    pause
)
exit /b %RC%

:nopython
echo.
echo [via-driver] Python not found.
echo.
echo Looked for:
echo   %%USERPROFILE%%\.workbuddy\binaries\python\versions\*\python.exe
echo   %%LOCALAPPDATA%%\Programs\Python\Python3*\python.exe
echo   C:\Python3*\python.exe
echo   py -3
echo.
echo Do NOT call a bare "python" command: on this machine it may be a 0-byte
echo Microsoft Store stub that opens the Store instead of running anything.
echo.
pause
exit /b 1
