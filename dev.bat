@echo off
cd /d "%~dp0"
echo ==========================================================
echo   VIA Driver fork - local dev server
echo.
echo   1. Wait until you see "ready in ..." below
echo   2. Open Chrome or Edge:  http://127.0.0.1:5173
echo   3. Close this window to stop the server
echo ==========================================================
echo.
node scripts\build-definitions-local.js
if errorlevel 1 goto :error
node scripts\sync-pic-uploader.js
if errorlevel 1 goto :error
npx vite --host 127.0.0.1 --port 5173 --strictPort
goto :done
:error
echo.
echo [ERROR] Definition build failed. Server not started.
:done
echo.
echo Server stopped.
pause
