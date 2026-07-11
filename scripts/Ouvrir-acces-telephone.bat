@echo off
chcp 65001 >nul
title Cortex - Ouvrir l'acces telephone
REM Se relance en administrateur si necessaire (le pare-feu l'exige).
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Demande des droits administrateur...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
echo ================================================
echo   Ouverture de l'acces telephone (port 5000)
echo ================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetFirewallRule | Where-Object { $_.DisplayName -match 'pythonw' -and $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue;" ^
  "if (-not (Get-NetFirewallRule -DisplayName 'Cortex (port 5000)' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Cortex (port 5000)' -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow -Profile Any | Out-Null };" ^
  "Write-Host 'Regles pare-feu mises a jour.'"
echo.
echo ================================================
echo   Termine ! Ton telephone peut maintenant se
echo   connecter (meme Wi-Fi). Rescanne le QR code.
echo ================================================
echo.
pause
