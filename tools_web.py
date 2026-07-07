import os
import subprocess

# Dossiers exclus de la recherche et du listing récursif.
IGNORES = {".git", "venv", "__pycache__", ".idea", "node_modules", ".vscode"}

# Extensions considérées comme du texte pour la recherche.
EXT_TEXTE = {
    ".py", ".js", ".ts", ".html", ".css", ".json", ".md", ".txt", ".yml",
    ".yaml", ".sql", ".sh", ".bat", ".env", ".cfg", ".ini", ".toml", ".xml",
    ".csv", ".jsx", ".tsx", ".vue", ".c", ".cpp", ".h", ".java", ".php",
}


def resoudre(base, chemin):
    """Résout `chemin` (relatif à `base`, ou absolu) et le confine à `base`.
    Retourne le chemin absolu, ou None si tentative de sortie du dossier."""
    base = os.path.abspath(base or ".")
    if not chemin:
        return base
    cible = chemin if os.path.isabs(chemin) else os.path.join(base, chemin)
    cible = os.path.abspath(cible)
    try:
        if os.path.commonpath([base, cible]) != base:
            return None
    except ValueError:  # lecteurs différents (Windows)
        return None
    return cible


ERREUR_SORTIE = "Erreur : chemin en dehors du dossier de travail"


def lire_fichier(chemin: str, base: str = ".") -> str:
    """Lit le contenu d'un fichier"""
    cible = resoudre(base, chemin)
    if cible is None:
        return ERREUR_SORTIE
    try:
        with open(cible, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        return f"Erreur : {e}"


def ecrire_fichier(chemin: str, contenu: str, base: str = ".") -> str:
    """Écrit ou remplace le contenu d'un fichier"""
    cible = resoudre(base, chemin)
    if cible is None:
        return ERREUR_SORTIE
    try:
        dossier = os.path.dirname(cible)
        if dossier:
            os.makedirs(dossier, exist_ok=True)
        with open(cible, "w", encoding="utf-8") as f:
            f.write(contenu)
        return f"Fichier {chemin} écrit avec succès"
    except Exception as e:
        return f"Erreur : {e}"


def remplacer_texte(chemin: str, ancien: str, nouveau: str, base: str = ".") -> str:
    """Remplace toutes les occurrences d'un texte exact dans un fichier"""
    cible = resoudre(base, chemin)
    if cible is None:
        return ERREUR_SORTIE
    if not ancien:
        return "Erreur : le texte à remplacer est vide"
    try:
        with open(cible, "r", encoding="utf-8") as f:
            contenu = f.read()
    except Exception as e:
        return f"Erreur : {e}"
    nombre = contenu.count(ancien)
    if nombre == 0:
        return (f"Erreur : texte introuvable dans {chemin}. "
                "Relis le fichier : le texte doit correspondre exactement "
                "(espaces et indentation compris).")
    try:
        with open(cible, "w", encoding="utf-8") as f:
            f.write(contenu.replace(ancien, nouveau))
        return f"{nombre} occurrence(s) remplacée(s) dans {chemin}"
    except Exception as e:
        return f"Erreur : {e}"


def executer_commande(commande: str, base: str = ".") -> str:
    """Exécute une commande dans le terminal et retourne le résultat"""
    try:
        result = subprocess.run(
            commande, shell=True, capture_output=True, text=True,
            timeout=60, cwd=base,
        )
        return f"Code retour : {result.returncode}\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}"
    except subprocess.TimeoutExpired:
        return "Erreur : la commande a dépassé le délai de 60 secondes"
    except Exception as e:
        return f"Erreur : {e}"


def lister_fichiers(dossier: str = ".", base: str = ".") -> str:
    """Liste les fichiers d'un dossier (les dossiers sont suffixés par /)"""
    cible = resoudre(base, dossier)
    if cible is None:
        return ERREUR_SORTIE
    try:
        entrees = []
        for nom in sorted(os.listdir(cible)):
            if nom in IGNORES:
                continue
            chemin = os.path.join(cible, nom)
            entrees.append(nom + "/" if os.path.isdir(chemin) else nom)
        return "\n".join(entrees) if entrees else "(dossier vide)"
    except Exception as e:
        return f"Erreur : {e}"


def chercher_texte(motif: str, dossier: str = ".", base: str = ".") -> str:
    """Cherche un texte dans tous les fichiers texte du dossier (récursif).
    Retourne les correspondances au format chemin:ligne: contenu."""
    if not motif:
        return "Erreur : motif vide"
    racine_abs = resoudre(base, dossier)
    if racine_abs is None:
        return ERREUR_SORTIE
    resultats = []
    motif_bas = motif.lower()
    try:
        for racine, dossiers, fichiers in os.walk(racine_abs):
            dossiers[:] = [d for d in dossiers if d not in IGNORES]
            for nom in fichiers:
                ext = os.path.splitext(nom)[1].lower()
                if ext not in EXT_TEXTE and "." in nom:
                    continue
                chemin = os.path.join(racine, nom)
                rel = os.path.relpath(chemin, racine_abs)
                try:
                    with open(chemin, "r", encoding="utf-8") as f:
                        for num, ligne in enumerate(f, 1):
                            if motif_bas in ligne.lower():
                                extrait = ligne.strip()
                                if len(extrait) > 200:
                                    extrait = extrait[:200] + "…"
                                resultats.append(f"{rel}:{num}: {extrait}")
                                if len(resultats) >= 80:
                                    resultats.append("[... résultats limités à 80 ...]")
                                    return "\n".join(resultats)
                except (UnicodeDecodeError, PermissionError, OSError):
                    continue
    except Exception as e:
        return f"Erreur : {e}"
    return "\n".join(resultats) if resultats else f"Aucune correspondance pour « {motif} »"


def creer_dossier(chemin: str, base: str = ".") -> str:
    """Crée un dossier (et ses parents si besoin)"""
    cible = resoudre(base, chemin)
    if cible is None:
        return ERREUR_SORTIE
    try:
        os.makedirs(cible, exist_ok=True)
        return f"Dossier {chemin} créé"
    except Exception as e:
        return f"Erreur : {e}"


def supprimer_fichier(chemin: str, base: str = ".") -> str:
    """Supprime un fichier (pas un dossier)"""
    cible = resoudre(base, chemin)
    if cible is None:
        return ERREUR_SORTIE
    try:
        if not os.path.isfile(cible):
            return f"Erreur : {chemin} n'est pas un fichier existant"
        os.remove(cible)
        return f"Fichier {chemin} supprimé"
    except Exception as e:
        return f"Erreur : {e}"


def renommer(source: str, destination: str, base: str = ".") -> str:
    """Renomme ou déplace un fichier/dossier à l'intérieur du dossier de travail."""
    src = resoudre(base, source)
    dst = resoudre(base, destination)
    if src is None or dst is None:
        return ERREUR_SORTIE
    if not os.path.exists(src):
        return f"Erreur : {source} n'existe pas"
    if os.path.exists(dst):
        return f"Erreur : {destination} existe déjà (déplacement annulé)"
    try:
        parent = os.path.dirname(dst)
        if parent:
            os.makedirs(parent, exist_ok=True)
        os.rename(src, dst)
        return f"{source} → {destination}"
    except Exception as e:
        return f"Erreur : {e}"


def lire_extrait(chemin: str, debut: int = 1, lignes: int = 200, base: str = ".") -> str:
    """Lit une portion d'un fichier : `lignes` lignes à partir de la ligne `debut`
    (1 = première ligne). Pour explorer un gros fichier sans tout charger."""
    cible = resoudre(base, chemin)
    if cible is None:
        return ERREUR_SORTIE
    try:
        with open(cible, "r", encoding="utf-8") as f:
            toutes = f.readlines()
    except Exception as e:
        return f"Erreur : {e}"
    total = len(toutes)
    try:
        debut = max(1, int(debut))
        lignes = max(1, int(lignes))
    except (TypeError, ValueError):
        return "Erreur : « debut » et « lignes » doivent être des entiers"
    portion = toutes[debut - 1:debut - 1 + lignes]
    if not portion:
        return f"(aucune ligne à partir de {debut} : le fichier compte {total} ligne(s))"
    fin = debut + len(portion) - 1
    return f"[lignes {debut}–{fin} sur {total}]\n" + "".join(portion)
