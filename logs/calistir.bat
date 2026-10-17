@echo off
chcp 65001 >nul
rem Bu dosya hangi klasorde olursa olsun, src\index.js'i bulana kadar bir ust klasore cikar
cd /d "%~dp0"
set "BATDIR=%~dp0"
if not exist "src\index.js" cd /d ".."
if not exist "src\index.js" (
  echo HATA: src\index.js bulunamadi. calistir.bat dosyasini reminder-bot klasorune ^(veya icindeki bir alt klasore^) koy.
  pause
  exit /b 1
)
set "LOGFILE=%BATDIR%servis.log"
title Hatirlatici Servisi

rem Bu pencere acik oldukca bilgisayar uykuya gitmesin
if exist "%BATDIR%uyku-engelle.ps1" (
  start "" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%BATDIR%uyku-engelle.ps1"
  echo Uyku engeli acik: bu pencere acik oldukca bilgisayar uykuya gitmeyecek.
) else (
  echo UYARI: uyku-engelle.ps1 bulunamadi, bilgisayar uykuya gidebilir.
)

:dongu
echo.
echo [%date% %time%] Servis basliyor... ^(klasor: %cd%^)
powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; cmd /c 'node src/index.js 2>&1' | ForEach-Object { $_; Add-Content -Path $env:LOGFILE -Value $_ -Encoding UTF8 }"
echo [%date% %time%] Servis durdu. 10 saniye sonra yeniden baslayacak...
timeout /t 10 /nobreak >nul
goto dongu
