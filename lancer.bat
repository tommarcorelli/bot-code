@echo off
chcp 65001 >nul
title Cortex - Agent de Code
cd /d "%~dp0"
REM Ecoute reseau local : PC en 127.0.0.1, telephone via l'IP LAN (bouton phone).
set HOST=0.0.0.0
echo ================================================
echo   Demarrage de Cortex...
echo   Le navigateur va s'ouvrir automatiquement.
echo   Telephone : bouton phone dans l'interface (meme Wi-Fi).
echo   Ferme cette fenetre (ou Ctrl+C) pour arreter.
echo ================================================
echo.
REM Ouvre le navigateur apres 2s, le temps que le serveur demarre
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5000"
REM Lance le serveur Flask (bloque tant que le serveur tourne)
venv\Scripts\python.exe app.py
echo.
echo Serveur arrete.
pause
