' Demarrer-agent.vbs
' Lance Cortex SANS fenetre console, puis ouvre le navigateur.
' Une seule icone : l'acces telephone (meme Wi-Fi) est integre.
' Pour arreter le serveur : bouton power en haut a droite de l'interface.
Option Explicit
Dim fso, sh, dossier, python, app
Set fso = CreateObject("Scripting.FileSystemObject")
dossier = fso.GetParentFolderName(WScript.ScriptFullName)
python = dossier & "\venv\Scripts\pythonw.exe"
app = dossier & "\app.py"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dossier
If Not fso.FileExists(python) Then
  MsgBox "Environnement Python introuvable." & vbCrLf & _
         "Lance installer.bat une premiere fois pour tout preparer.", _
         vbExclamation, "Cortex"
  WScript.Quit
End If
' Serveur local uniquement (127.0.0.1). Pour l'acces telephone, decommenter :
' sh.Environment("PROCESS")("HOST") = "0.0.0.0"
' Demarre le serveur, fenetre masquee (0), sans attendre la fin.
' (Si un serveur tourne deja, app.py s'arrete aussitot : pas de doublon,
'  le navigateur s'ouvre simplement sur l'instance existante.)
sh.Run """" & python & """ """ & app & """", 0, False
' Laisse le serveur demarrer, puis ouvre le navigateur.
WScript.Sleep 2500
sh.Run "http://127.0.0.1:5000", 1, False
