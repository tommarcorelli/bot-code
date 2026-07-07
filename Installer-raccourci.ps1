# Installer-raccourci.ps1 — cree les raccourcis de l'Agent de Code sur le bureau.
$dossier = Split-Path -Parent $MyInvocation.MyCommand.Path
$icone   = Join-Path $dossier "agent.ico"
$bureau  = [Environment]::GetFolderPath("Desktop")
$ws      = New-Object -ComObject WScript.Shell

function Nouveau-Raccourci($nom, $cibleVbs, $desc) {
  $lien = $ws.CreateShortcut((Join-Path $bureau "$nom.lnk"))
  $lien.TargetPath       = "wscript.exe"
  $lien.Arguments        = '"' + (Join-Path $dossier $cibleVbs) + '"'
  $lien.WorkingDirectory = $dossier
  $lien.IconLocation     = $icone
  $lien.Description       = $desc
  $lien.Save()
  Write-Host "  Cree : $nom.lnk"
}

Write-Host "Creation des raccourcis sur le bureau..."
Nouveau-Raccourci "Cortex"         "Demarrer-agent.vbs"      "Lance Cortex (ce PC uniquement)"
Nouveau-Raccourci "Cortex (Wi-Fi)" "Demarrer-agent-wifi.vbs" "Lance Cortex avec l'acces telephone (meme Wi-Fi)"
Write-Host ""
Write-Host "Termine. Deux icones sont sur ton bureau :"
Write-Host "  - Cortex          -> usage sur ce PC"
Write-Host "  - Cortex (Wi-Fi)  -> quand tu veux aussi l'ouvrir sur le telephone"
