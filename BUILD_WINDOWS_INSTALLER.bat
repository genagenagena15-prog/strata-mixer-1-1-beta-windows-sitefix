@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ==========================================
echo Strata Mixer v1.0 - Windows Setup Builder
echo ==========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js LTS is not installed or not added to PATH.
  echo Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found. Reinstall Node.js LTS.
  pause
  exit /b 1
)

echo Installing packages...
call npm install
if errorlevel 1 goto fail

echo Building Windows app...
call npm run package:win
if errorlevel 1 goto fail

set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"

if "%ISCC%"=="" (
  echo.
  echo Electron app was built successfully, but Inno Setup was not found.
  echo To create one setup file, install Inno Setup 6 and run this file again:
  echo https://jrsoftware.org/isdl.php
  echo.
  echo App folder is here:
  echo release\StrataMixer_1_0-win32-x64
  pause
  exit /b 1
)

echo Creating installer...
"%ISCC%" installer_strata_mixer_1_1_beta.iss
if errorlevel 1 goto fail

echo.
echo DONE!
echo Installer:
echo installer-output\StrataMixer_Setup_1_0.exe
echo.
pause
exit /b 0

:fail
echo.
echo ERROR: Build failed. Check the messages above.
pause
exit /b 1
