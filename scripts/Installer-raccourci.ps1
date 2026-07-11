# Installer-raccourci.ps1 — cree les raccourcis de l'Agent de Code sur le bureau.
$dossier = Split-Path -Parent $MyInvocation.MyCommand.Path   # ...\scripts
$racine  = Split-Path -Parent $dossier                       # racine du projet
$icone   = Join-Path $dossier "agent.ico"
$bureau  = [Environment]::GetFolderPath("Desktop")
$ws      = New-Object -ComObject WScript.Shell

function Nouveau-Raccourci($nom, $cibleVbs, $desc) {
  $lien = $ws.CreateShortcut((Join-Path $bureau "$nom.lnk"))
  $lien.TargetPath       = "wscript.exe"
  $lien.Arguments        = '"' + (Join-Path $dossier $cibleVbs) + '"'
  $lien.WorkingDirectory = $racine
  $lien.IconLocation     = $icone
  $lien.Description       = $desc
  $lien.Save()
  Write-Host "  Cree : $nom.lnk"
}

# Nettoie l'ancien raccourci Wi-Fi s'il traine (fusionne dans une seule icone).
$ancien = Join-Path $bureau "Cortex (Wi-Fi).lnk"
if (Test-Path $ancien) { Remove-Item $ancien -Force; Write-Host "  Supprime : Cortex (Wi-Fi).lnk (fusionne)" }

Write-Host "Creation du raccourci sur le bureau..."
Nouveau-Raccourci "Cortex" "Demarrer-agent.vbs" "Lance Cortex (PC + acces telephone sur le meme Wi-Fi)"
Write-Host ""
Write-Host "Termine. Une seule icone Cortex est sur ton bureau."
Write-Host "  Elle sert a la fois sur ce PC et pour le telephone (bouton 📱)."
