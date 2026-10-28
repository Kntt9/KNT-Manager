@echo off
title Build
cd /d "%~dp0"
echo Building KNT Manager executable...
echo.

where cargo >nul 2>&1
if errorlevel 1 (echo Rust toolchain not found - install from https://rustup.rs & pause & exit /b 1)

echo Precompiling native helper...
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if exist "%CSC%" (
  "%CSC%" /nologo /optimize+ /platform:x64 /target:exe /r:System.Drawing.dll /out:src-tauri\resources\RobloxNative.exe src-tauri\resources\RobloxNative.cs
  if errorlevel 1 (echo Native helper compilation failed & pause & exit /b 1)
) else (
  echo csc.exe not found - install the .NET Framework compiler before building
  pause
  exit /b 1
)

cargo build --release --manifest-path src-tauri\Cargo.toml --bin MultiRoblox
if errorlevel 1 (echo Build failed & pause & exit /b 1)

if not exist dist mkdir dist
copy /y "src-tauri\target\release\MultiRoblox.exe" "dist\KNT-Manager.exe" >nul
if errorlevel 1 (echo Could not copy KNT-Manager.exe & pause & exit /b 1)
if exist "dist\MultiRoblox.exe" del "dist\MultiRoblox.exe"

echo Copying assets...
xcopy /y /i /q "src\assets" "dist\assets\" >nul 2>&1

echo.
echo Done. Executable: dist\KNT-Manager.exe
pause
