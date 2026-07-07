' Demarrer-agent-wifi.vbs
' Comme Demarrer-agent.vbs, mais active l'acces reseau local :
' Cortex devient joignable depuis le telephone (meme Wi-Fi).
' Le lien + QR code sont dans le bouton telephone de l'interface.
Option Explicit
Dim fso, sh, dossier, python, app
Set fso = CreateObject("Scripting.FileSystemObject")
dossier = fso.GetParentFolderName(WScript.ScriptFullName)
python = dossier & "\venv\Scripts\pythonw.exe"
app = dossier & "\app.py"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dossier
If Not fso.FileExists(python) Then
  MsgBox "Environnement Python introuvable. Lance installer.bat d'abord.", _
         vbExclamation, "Cortex"
  WScript.Quit
End If
' Active l'ecoute reseau pour le process serveur (et ses enfants).
sh.Environment("PROCESS")("HOST") = "0.0.0.0"
sh.Run """" & python & """ """ & app & """", 0, False
WScript.Sleep 2500
sh.Run "http://127.0.0.1:5000", 1, False
