import subprocess
import os

def lire_fichier(chemin: str) -> str:
    """Lit le contenu d'un fichier"""
    try:
        with open(chemin, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"Erreur : {e}"

def ecrire_fichier(chemin: str, contenu: str) -> str:
    """Écrit ou remplace le contenu d'un fichier"""
    print(f"\n⚠️  L'agent veut écrire dans : {chemin}")
    print(f"--- Contenu ---\n{contenu}\n---------------")
    confirmation = input("Confirmer l'écriture ? (o/n) : ")
    if confirmation.lower() != "o":
        return "Action annulée par l'utilisateur"
    try:
        with open(chemin, 'w', encoding='utf-8') as f:
            f.write(contenu)
        return f"Fichier {chemin} écrit avec succès"
    except Exception as e:
        return f"Erreur : {e}"

def executer_commande(commande: str) -> str:
    """Exécute une commande dans le terminal et retourne le résultat"""
    print(f"\n⚠️  L'agent veut exécuter : {commande}")
    confirmation = input("Confirmer l'exécution ? (o/n) : ")
    if confirmation.lower() != "o":
        return "Action annulée par l'utilisateur"
    try:
        result = subprocess.run(commande, shell=True, capture_output=True, text=True, timeout=30)
        return f"STDOUT: {result.stdout}\nSTDERR: {result.stderr}"
    except Exception as e:
        return f"Erreur : {e}"

def lister_fichiers(dossier: str = ".") -> str:
    """Liste les fichiers d'un dossier"""
    try:
        return "\n".join(os.listdir(dossier))
    except Exception as e:
        return f"Erreur : {e}"