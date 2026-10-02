@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Klang.lnk');" ^
  "$s.TargetPath='%~dp0Klang.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7;" ^
  "$s.IconLocation='%~dp0ui\klang.ico'; $s.Description='Klang music player'; $s.Save()"
echo Klang is now on your desktop.
timeout /t 3 >nul
