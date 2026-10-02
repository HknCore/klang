@echo off
setlocal
cd /d "%~dp0"
title Klang

if exist ".venv\Scripts\pythonw.exe" goto run

echo.
echo   Setting up Klang. This only happens once and takes about a minute.
echo.
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY goto nopython

%PY% -m venv .venv || goto fail
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q --upgrade pip
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto fail
echo   Done. Starting Klang...

:run
start "" ".venv\Scripts\pythonw.exe" server.py
exit /b 0

:nopython
echo   Klang needs Python 3.9 or newer.
echo.
echo   Install it with:   winget install Python.Python.3.12
echo   or download it from https://www.python.org/downloads/
echo   (tick "Add python.exe to PATH" during setup), then run Klang.bat again.
echo.
pause
exit /b 1

:fail
echo.
echo   Setup failed. Delete the .venv folder next to this file and run Klang.bat again.
echo.
pause
exit /b 1
