@echo off
chcp 65001 >nul
title Cortex - Wi-Fi (telephone)
cd /d "%~dp0"
set HOST=0.0.0.0
echo ================================================
echo   Agent de Code - acces telephone (meme Wi-Fi)
echo   Le lien pour le telephone s'affiche ci-dessous.
echo   Ferme cette fenetre (ou Ctrl+C) pour arreter.
echo ================================================
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5000"
venv\Scripts\python.exe app.py
echo.
echo Serveur arrete.
pause
