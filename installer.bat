@echo off
chcp 65001 >nul
title Cortex - Installation
cd /d "%~dp0"
echo ================================================
echo   Installation de Cortex
echo ================================================
echo.
if not exist "venv\Scripts\python.exe" (
  echo [1/3] Creation de l'environnement Python...
  python -m venv venv
) else (
  echo [1/3] Environnement Python deja present.
)
echo [2/3] Installation des dependances...
venv\Scripts\python.exe -m pip install --upgrade pip >nul
venv\Scripts\python.exe -m pip install -r requirements.txt
echo [3/3] Creation des raccourcis sur le bureau...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Installer-raccourci.ps1"
echo.
echo ================================================
echo   Termine ! Double-clique sur l'icone
echo   "Cortex" de ton bureau.
echo ================================================
pause
