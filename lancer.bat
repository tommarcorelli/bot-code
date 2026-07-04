@echo off
title Agent de Code - Devstral
cd /d "%~dp0"
echo ================================================
echo   Demarrage de l'Agent de Code...
echo   Le navigateur va s'ouvrir automatiquement.
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
