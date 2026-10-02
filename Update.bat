@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run Klang.bat first.
  pause
  exit /b 1
)
echo Updating the YouTube Music connector...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q --upgrade -r requirements.txt && echo Up to date.
pause
