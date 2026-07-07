import os
import re
import sys
import json
import time
import uuid
import shutil
import socket
import difflib
import secrets
import subprocess
import urllib.request
from flask import Flask, render_template, request, jsonify, send_from_directory, send_file, Response, abort
from werkzeug.utils import secure_filename
from mistralai.client import Mistral
from openai import OpenAI
from dotenv import load_dotenv
import tools_web as tools

# Lancé sans console (raccourci -> pythonw.exe), sys.stdout/stderr valent None :
# le moindre print() ferait planter le serveur. On les redirige vers le vide.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

load_dotenv()

app = Flask(__name__)
# Taille maximale d'un fichier téléversé (15 Mo).
app.config["MAX_CONTENT_LENGTH"] = 15 * 1024 * 1024

client = Mistral(api_key=os.getenv("MISTRAL_API_KEY"))

# Groq : API compatible OpenAI (function calling gratuit et rapide).
# Le client n'existe que si une clé est présente dans le .env.
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
groq_client = (OpenAI(base_url="https://api.groq.com/openai/v1", api_key=GROQ_API_KEY)
               if GROQ_API_KEY else None)

# Gemini : endpoint compatible OpenAI de Google (function calling gratuit).
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
gemini_client = (OpenAI(base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
                        api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None)

# Racine de l'application (fallback du dossier de travail).
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
# Un fichier JSON par conversation.
CONV_DIR = os.path.join(BASE_DIR, "conversations")
# Sauvegardes des fichiers avant modification (pour l'annulation).
SAUV_DIR = os.path.join(BASE_DIR, "sauvegardes")
JOURNAL_FICHIER = os.path.join(SAUV_DIR, "journal.json")
CONFIG_FICHIER = os.path.join(BASE_DIR, "config.json")
os.makedirs(CONV_DIR, exist_ok=True)
os.makedirs(SAUV_DIR, exist_ok=True)

# Entrées masquées dans l'explorateur (.env caché pour ne pas exposer la clé API).
DOSSIERS_IGNORES = {".git", "venv", "__pycache__", ".idea", "node_modules",
                    ".env", "conversations", "sauvegardes"}

# Outils qui exigent une confirmation de l'utilisateur avant exécution.
OUTILS_SENSIBLES = {"ecrire_fichier", "remplacer_texte", "executer_commande",
                    "supprimer_fichier", "renommer"}
# Outils dont l'effet peut être annulé (sauvegarde du fichier avant exécution).
OUTILS_ANNULABLES = {"ecrire_fichier", "remplacer_texte", "supprimer_fichier"}

MODELE_DEFAUT = "mistral:devstral-latest"
MODELES_MISTRAL = [
    {"id": "mistral:devstral-latest", "nom": "Devstral · code (défaut)"},
    {"id": "mistral:mistral-small-latest", "nom": "Mistral Small · rapide"},
    {"id": "mistral:mistral-large-latest", "nom": "Mistral Large · puissant"},
    {"id": "mistral:codestral-latest", "nom": "Codestral · code"},
]
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")

# Modèles Groq recommandés (bons en function calling). La liste réellement
# proposée est filtrée par ce que l'API Groq expose au moment de l'appel,
# pour rester robuste si un modèle est renommé ou déprécié.
GROQ_CANDIDATS = [
    ("llama-3.3-70b-versatile", "Llama 3.3 70B · Groq (gratuit)"),
    ("llama-3.1-8b-instant", "Llama 3.1 8B · Groq (rapide)"),
    ("qwen-2.5-32b", "Qwen 2.5 32B · Groq"),
    ("deepseek-r1-distill-llama-70b", "DeepSeek R1 70B · Groq"),
]
GROQ_EXCLUS = ("whisper", "tts", "guard", "distil", "embed", "vision")

GEMINI_CANDIDATS = [
    ("gemini-2.5-flash", "Gemini 2.5 Flash · Google (gratuit)"),
    ("gemini-2.5-pro", "Gemini 2.5 Pro · Google"),
    ("gemini-2.0-flash", "Gemini 2.0 Flash · Google (rapide)"),
]
GEMINI_EXCLUS = ("embedding", "aqa", "imagen", "tts", "learnlm",
                 "deep-research", "antigravity", "preview", "exp",
                 "robotics", "computer-use", "image", "audio")

# Au-delà de ce volume (en caractères, ~4 caractères par token), on compacte
# l'historique avant d'appeler le modèle.
SEUIL_COMPACTION = 150_000

SYSTEM_PROMPT = (
    "Tu es un agent de développement expert. "
    "Tu travailles dans le dossier de travail choisi par l'utilisateur, sous Windows "
    "(executer_commande passe par cmd.exe, les chemins sont relatifs à ce dossier). "
    "Méthode : explore d'abord (lister_fichiers, lire_fichier — ou lire_extrait pour "
    "les gros fichiers, chercher_texte), puis agis, puis vérifie ton travail. "
    "Pour modifier un fichier existant, préfère remplacer_texte (modification ciblée) "
    "à ecrire_fichier (réécriture complète). Pour déplacer ou renommer, utilise renommer. "
    "N'invente jamais le contenu d'un fichier : lis-le. "
    "Réponds en français, de façon concise, en Markdown ; cite les fichiers que tu modifies."
)

outils_definitions = [
    {
        "type": "function",
        "function": {
            "name": "lire_fichier",
            "description": "Lit le contenu d'un fichier",
            "parameters": {
                "type": "object",
                "properties": {"chemin": {"type": "string"}},
                "required": ["chemin"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ecrire_fichier",
            "description": "Écrit ou remplace ENTIÈREMENT un fichier (crée les dossiers parents si besoin). Pour une modification partielle, utiliser remplacer_texte.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chemin": {"type": "string"},
                    "contenu": {"type": "string"}
                },
                "required": ["chemin", "contenu"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "remplacer_texte",
            "description": "Remplace toutes les occurrences d'un texte exact dans un fichier. À préférer à ecrire_fichier pour modifier un fichier existant. Le texte doit correspondre exactement (indentation comprise).",
            "parameters": {
                "type": "object",
                "properties": {
                    "chemin": {"type": "string"},
                    "ancien": {"type": "string"},
                    "nouveau": {"type": "string"}
                },
                "required": ["chemin", "ancien", "nouveau"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "executer_commande",
            "description": "Exécute une commande shell (cmd.exe) dans le dossier de travail et retourne le résultat",
            "parameters": {
                "type": "object",
                "properties": {"commande": {"type": "string"}},
                "required": ["commande"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "lister_fichiers",
            "description": "Liste les fichiers d'un dossier (les dossiers sont suffixés par /)",
            "parameters": {
                "type": "object",
                "properties": {"dossier": {"type": "string"}},
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "chercher_texte",
            "description": "Cherche un texte (insensible à la casse) dans tous les fichiers du projet, récursivement. Retourne chemin:ligne: contenu",
            "parameters": {
                "type": "object",
                "properties": {
                    "motif": {"type": "string"},
                    "dossier": {"type": "string"}
                },
                "required": ["motif"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "creer_dossier",
            "description": "Crée un dossier (et ses parents si besoin)",
            "parameters": {
                "type": "object",
                "properties": {"chemin": {"type": "string"}},
                "required": ["chemin"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "supprimer_fichier",
            "description": "Supprime un fichier (pas un dossier)",
            "parameters": {
                "type": "object",
                "properties": {"chemin": {"type": "string"}},
                "required": ["chemin"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "renommer",
            "description": "Renomme ou déplace un fichier/dossier dans le dossier de travail",
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {"type": "string"},
                    "destination": {"type": "string"}
                },
                "required": ["source", "destination"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "lire_extrait",
            "description": "Lit une portion d'un fichier (à partir de la ligne 'debut', 'lignes' lignes). Idéal pour parcourir un gros fichier sans tout charger.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chemin": {"type": "string"},
                    "debut": {"type": "integer"},
                    "lignes": {"type": "integer"}
                },
                "required": ["chemin"]
            }
        }
    },
]

fonctions_disponibles = {
    "lire_fichier": tools.lire_fichier,
    "ecrire_fichier": tools.ecrire_fichier,
    "remplacer_texte": tools.remplacer_texte,
    "executer_commande": tools.executer_commande,
    "lister_fichiers": tools.lister_fichiers,
    "chercher_texte": tools.chercher_texte,
    "creer_dossier": tools.creer_dossier,
    "supprimer_fichier": tools.supprimer_fichier,
    "renommer": tools.renommer,
    "lire_extrait": tools.lire_extrait,
}

# État global (usage local mono-utilisateur).
en_attente = None
stop_flag = {"on": False}


# ---------------------------------------------------------------------------
# Configuration (dossier de travail + modèle par défaut)
# ---------------------------------------------------------------------------

def charger_config():
    config = {"workspace": BASE_DIR, "modele": MODELE_DEFAUT}
    try:
        with open(CONFIG_FICHIER, "r", encoding="utf-8") as f:
            config.update(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    if not os.path.isdir(config.get("workspace", "")):
        config["workspace"] = BASE_DIR
    return config


def sauver_config(config):
    try:
        with open(CONFIG_FICHIER, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=1)
    except Exception as e:
        print(f"[config] Échec sauvegarde : {e}")


# ---------------------------------------------------------------------------
# Sécurité : jeton d'accès partagé
# ---------------------------------------------------------------------------
# L'agent lit/écrit des fichiers et lance des commandes shell. Dès qu'on expose
# le serveur au réseau local (pour l'ouvrir sur le téléphone), il faut un
# garde-fou. Un jeton est généré une fois puis conservé dans config.json et
# exigé sur toutes les routes /api. Le PC (127.0.0.1) peut le récupérer
# automatiquement ; le téléphone le reçoit via le lien http://IP:5000/?cle=<jeton>.

def obtenir_cle():
    config = charger_config()
    cle = config.get("cle")
    if not cle:
        cle = secrets.token_urlsafe(24)
        config["cle"] = cle
        sauver_config(config)
    return cle


CLE_API = obtenir_cle()

# Routes servies sans jeton : le shell de l'appli et la remise du jeton en local.
CHEMINS_LIBRES = {"/", "/sw.js", "/api/cle-locale"}


def est_local():
    """Vrai si la requête vient de la machine elle-même (pas du réseau)."""
    return (request.remote_addr or "").split("%")[0] in ("127.0.0.1", "::1", "localhost")


@app.before_request
def controle_acces():
    chemin = request.path
    if not chemin.startswith("/api/") or chemin in CHEMINS_LIBRES:
        return  # shell, static, sw, remise du jeton : libres
    recue = request.headers.get("X-Cle") or request.args.get("cle")
    if not recue or not secrets.compare_digest(recue, CLE_API):
        abort(403)


def ip_locale():
    """Adresse IP de la machine sur le réseau local (pour l'accès téléphone)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # aucune donnée envoyée, juste pour lire l'IP source
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Persistance des conversations
# ---------------------------------------------------------------------------

def chemin_conv(cid):
    if not cid or not cid.isalnum():
        return None
    return os.path.join(CONV_DIR, f"{cid}.json")


def nouvelle_conv():
    config = charger_config()
    conv = {
        "id": uuid.uuid4().hex[:12],
        "titre": "Nouvelle conversation",
        "cree": time.time(),
        "messages": [],
        "usage": {"entree": 0, "sortie": 0},
        "workspace": config["workspace"],
        "modele": config["modele"],
    }
    sauvegarder_conv(conv)
    return conv


def sauvegarder_conv(conv):
    try:
        with open(chemin_conv(conv["id"]), "w", encoding="utf-8") as f:
            json.dump(conv, f, ensure_ascii=False, indent=1)
    except Exception as e:
        print(f"[persistance] Échec sauvegarde : {e}")


def charger_conv(cid):
    chemin = chemin_conv(cid)
    if not chemin or not os.path.exists(chemin):
        return None
    try:
        with open(chemin, "r", encoding="utf-8") as f:
            conv = json.load(f)
        conv.setdefault("usage", {"entree": 0, "sortie": 0})
        conv.setdefault("workspace", BASE_DIR)
        conv.setdefault("modele", MODELE_DEFAUT)
        return conv
    except Exception as e:
        print(f"[persistance] Échec chargement {cid} : {e}")
        return None


def base_travail(conv):
    ws = conv.get("workspace")
    return ws if ws and os.path.isdir(ws) else BASE_DIR


def liste_convs():
    entrees = []
    for nom in os.listdir(CONV_DIR):
        if not nom.endswith(".json"):
            continue
        conv = charger_conv(nom[:-5])
        if conv:
            entrees.append({
                "id": conv["id"],
                "titre": conv.get("titre", "Sans titre"),
                "cree": conv.get("cree", 0),
                "nb": sum(1 for m in conv["messages"] if m.get("role") == "user"),
            })
    entrees.sort(key=lambda c: c["cree"], reverse=True)
    return entrees


def migrer_ancien_historique():
    """Importe l'ancien conversations.json (format mono-conversation)."""
    ancien = os.path.join(BASE_DIR, "conversations.json")
    if not os.path.exists(ancien) or liste_convs():
        return
    try:
        with open(ancien, "r", encoding="utf-8") as f:
            messages = json.load(f)
        if messages:
            conv = nouvelle_conv()
            conv["messages"] = messages
            premier = next((m for m in messages if m.get("role") == "user"), None)
            if premier:
                conv["titre"] = (premier.get("content") or "")[:48] or conv["titre"]
            nettoyer_conv(conv)
            sauvegarder_conv(conv)
            print("[migration] Ancienne conversation importée.")
        os.rename(ancien, ancien + ".ancien")
    except Exception as e:
        print(f"[migration] Échec : {e}")


def nettoyer_conv(conv):
    """Retire une éventuelle séquence de tool_calls incomplète en fin
    d'historique (ex. serveur arrêté pendant une confirmation en attente)."""
    messages = conv["messages"]
    while messages:
        dernier = messages[-1]
        if dernier.get("role") == "tool":
            messages.pop()
            continue
        if dernier.get("role") == "assistant" and dernier.get("tool_calls"):
            messages.pop()
            continue
        break


def solder_attente():
    """Clôt proprement une confirmation en suspens : les tool_calls restants
    reçoivent un résultat « non exécuté » pour garder l'historique valide."""
    global en_attente
    if en_attente is None:
        return
    conv = charger_conv(en_attente["conv"])
    if conv:
        appels = en_attente["tool_calls"]
        for i in range(en_attente["index"], len(appels)):
            conv["messages"].append({
                "role": "tool",
                "name": appels[i]["function"]["name"],
                "content": "Non exécuté (action abandonnée par l'utilisateur)",
                "tool_call_id": appels[i]["id"],
            })
        sauvegarder_conv(conv)
    en_attente = None


# ---------------------------------------------------------------------------
# Sauvegardes avant modification (annulation)
# ---------------------------------------------------------------------------

def charger_journal():
    try:
        with open(JOURNAL_FICHIER, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def sauver_journal(journal):
    # On garde les 200 dernières entrées, et on purge leurs .bak orphelins.
    for vieille in journal[:-200]:
        bak = os.path.join(SAUV_DIR, vieille["id"] + ".bak")
        if os.path.exists(bak):
            try:
                os.remove(bak)
            except OSError:
                pass
    journal = journal[-200:]
    try:
        with open(JOURNAL_FICHIER, "w", encoding="utf-8") as f:
            json.dump(journal, f, ensure_ascii=False, indent=1)
    except Exception as e:
        print(f"[annulation] Échec journal : {e}")


def sauvegarder_avant(nom_outil, args, ws):
    """Avant un outil destructif : mémorise l'état du fichier cible.
    Retourne l'identifiant d'annulation, ou None si rien à sauvegarder."""
    chemin_rel = args.get("chemin")
    if nom_outil not in OUTILS_ANNULABLES or not chemin_rel:
        return None
    cible = tools.resoudre(ws, chemin_rel)
    if cible is None:
        return None
    ident = uuid.uuid4().hex[:10]
    entree = {"id": ident, "date": time.time(), "outil": nom_outil,
              "chemin": cible, "existait": os.path.isfile(cible)}
    if entree["existait"]:
        try:
            shutil.copy2(cible, os.path.join(SAUV_DIR, ident + ".bak"))
        except Exception:
            return None
    journal = charger_journal()
    journal.append(entree)
    sauver_journal(journal)
    return ident


def annuler_modification(ident):
    """Restaure l'état d'avant une modification. Retourne (ok, message)."""
    journal = charger_journal()
    entree = next((e for e in journal if e["id"] == ident), None)
    if entree is None:
        return False, "Annulation introuvable (trop ancienne ?)"
    cible = entree["chemin"]
    if entree["existait"]:
        bak = os.path.join(SAUV_DIR, ident + ".bak")
        if not os.path.exists(bak):
            return False, "Sauvegarde introuvable"
        try:
            os.makedirs(os.path.dirname(cible), exist_ok=True)
            shutil.copy2(bak, cible)
        except Exception as e:
            return False, f"Restauration impossible : {e}"
        return True, f"Fichier restauré : {os.path.basename(cible)}"
    # Le fichier n'existait pas : annuler = supprimer la création.
    try:
        if os.path.isfile(cible):
            os.remove(cible)
    except Exception as e:
        return False, f"Suppression impossible : {e}"
    return True, f"Création annulée : {os.path.basename(cible)}"


# ---------------------------------------------------------------------------
# Compaction du contexte
# ---------------------------------------------------------------------------

def taille_messages(messages):
    total = 0
    for m in messages:
        total += len(str(m.get("content") or ""))
        for tc in m.get("tool_calls") or []:
            total += len(tc["function"].get("arguments") or "")
    return total


def compacter(conv):
    """Réduit l'historique quand il devient trop volumineux.
    Retourne True si une compaction a eu lieu."""
    messages = conv["messages"]
    if taille_messages(messages) < SEUIL_COMPACTION:
        return False

    # Étape 1 : purger le contenu des vieux résultats d'outils (le plus gros).
    indices_tool = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
    for i in indices_tool[:-8]:
        if len(messages[i].get("content") or "") > 400:
            messages[i]["content"] = "[résultat d'outil purgé pour économiser le contexte]"
    if taille_messages(messages) < SEUIL_COMPACTION:
        sauvegarder_conv(conv)
        return True

    # Étape 2 : résumer la première moitié de la conversation.
    # On coupe sur un message utilisateur pour ne pas casser une séquence d'outils.
    limite = max(1, int(len(messages) * 0.6))
    coupe = 0
    for i in range(limite, 0, -1):
        if messages[i].get("role") == "user":
            coupe = i
            break
    if coupe == 0:
        return True  # rien à couper proprement, la purge devra suffire

    extrait = json.dumps(messages[:coupe], ensure_ascii=False)[:60000]
    try:
        reponse = client.chat.complete(
            model="mistral-small-latest",
            messages=[{
                "role": "user",
                "content": "Résume précisément cette partie de conversation entre un "
                           "utilisateur et un agent de code (décisions prises, fichiers "
                           "modifiés, état du travail). Réponds uniquement par le résumé, "
                           "en français :\n\n" + extrait,
            }],
        )
        resume = reponse.choices[0].message.content or ""
    except Exception:
        # Pas de résumé possible (ex. modèle local seul) : troncature simple.
        resume = "(résumé indisponible : début de conversation tronqué)"
    conv["messages"] = [{
        "role": "user",
        "content": "[Contexte résumé automatiquement — début de la conversation]\n\n" + resume,
    }] + messages[coupe:]
    sauvegarder_conv(conv)
    return True


# ---------------------------------------------------------------------------
# Tours de modèle (Mistral API et Ollama local)
# ---------------------------------------------------------------------------

def tour_mistral(conv, modele):
    texte = ""
    appels = []
    flux = client.chat.stream(
        model=modele,
        messages=[{"role": "system", "content": SYSTEM_PROMPT}] + conv["messages"],
        tools=outils_definitions,
        tool_choice="auto",
    )
    for event in flux:
        if stop_flag["on"]:
            break
        chunk = getattr(event, "data", None) or event
        usage = getattr(chunk, "usage", None)
        if usage is not None and getattr(usage, "prompt_tokens", None) is not None:
            conv["usage"]["entree"] += usage.prompt_tokens or 0
            conv["usage"]["sortie"] += usage.completion_tokens or 0
        choices = getattr(chunk, "choices", None)
        if not choices:
            continue
        delta = choices[0].delta

        contenu = getattr(delta, "content", None)
        if isinstance(contenu, list):
            contenu = "".join(
                (getattr(p, "text", None) or (p.get("text", "") if isinstance(p, dict) else "")) or ""
                for p in contenu
            )
        if isinstance(contenu, str) and contenu:
            texte += contenu
            yield {"type": "token", "t": contenu}

        tcs = getattr(delta, "tool_calls", None)
        if isinstance(tcs, list):
            for tc in tcs:
                idx = getattr(tc, "index", None)
                if not isinstance(idx, int):
                    idx = len(appels) if getattr(tc, "id", None) or not appels else len(appels) - 1
                while len(appels) <= idx:
                    appels.append({"id": None, "type": "function",
                                   "function": {"name": "", "arguments": ""}})
                a = appels[idx]
                if getattr(tc, "id", None):
                    a["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn is not None:
                    nom = getattr(fn, "name", None)
                    if isinstance(nom, str) and nom:
                        a["function"]["name"] = nom
                    args = getattr(fn, "arguments", None)
                    if args:
                        if not isinstance(args, str):
                            args = json.dumps(args)
                        a["function"]["arguments"] += args
    for a in appels:
        if not a["id"]:
            a["id"] = uuid.uuid4().hex[:9]
    return texte, appels


def messages_pour_ollama(conv):
    """Convertit l'historique (format Mistral) vers le format Ollama."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in conv["messages"]:
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            appels = []
            for tc in m["tool_calls"]:
                try:
                    arguments = json.loads(tc["function"]["arguments"] or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                appels.append({"function": {"name": tc["function"]["name"],
                                            "arguments": arguments}})
            messages.append({"role": "assistant", "content": m.get("content") or "",
                             "tool_calls": appels})
        elif role == "tool":
            messages.append({"role": "tool", "content": m.get("content") or ""})
        else:
            messages.append({"role": role, "content": m.get("content") or ""})
    return messages


def extraire_objets_json(texte):
    """Renvoie les objets JSON équilibrés {...} trouvés dans le texte (gère
    l'imbrication, contrairement à une regex). Utilisé pour récupérer un appel
    d'outil noyé dans du texte."""
    objets = []
    profondeur = 0
    debut = -1
    for i, c in enumerate(texte):
        if c == "{":
            if profondeur == 0:
                debut = i
            profondeur += 1
        elif c == "}" and profondeur > 0:
            profondeur -= 1
            if profondeur == 0 and debut >= 0:
                objets.append(texte[debut:i + 1])
                debut = -1
    return objets


def parser_appels_texte(texte):
    """Repli : certains modèles locaux (via Ollama) écrivent l'appel d'outil
    en JSON dans le texte au lieu d'utiliser le champ tool_calls natif. On les
    récupère ici, même quand du texte entoure le JSON."""
    if not texte:
        return []
    nettoye = re.sub(r"</?tool_call>|```(?:json)?", " ", texte)
    appels = []
    for bloc in extraire_objets_json(nettoye):
        try:
            item = json.loads(bloc)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(item, dict):
            continue
        nom = item.get("name") or item.get("tool") or item.get("function")
        if isinstance(nom, dict):
            nom = nom.get("name")
        args = item.get("arguments") or item.get("parameters") or item.get("args") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}
        if nom in fonctions_disponibles:
            appels.append({
                "id": uuid.uuid4().hex[:9], "type": "function",
                "function": {"name": nom,
                             "arguments": json.dumps(args, ensure_ascii=False)},
            })
    return appels


def tour_ollama(conv, modele):
    texte = ""
    appels = []
    # bufferise : None tant qu'indéterminé, True si le contenu ressemble à un
    # appel d'outil écrit en texte (on le retient au lieu de le streamer).
    bufferise = None
    corps = json.dumps({
        "model": modele,
        "messages": messages_pour_ollama(conv),
        "tools": outils_definitions,
        "stream": True,
    }).encode("utf-8")
    requete = urllib.request.Request(
        OLLAMA_URL + "/api/chat", data=corps,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(requete, timeout=600) as reponse:
        for ligne in reponse:
            if stop_flag["on"]:
                break
            try:
                d = json.loads(ligne)
            except json.JSONDecodeError:
                continue
            message = d.get("message") or {}
            contenu = message.get("content")
            if contenu:
                texte += contenu
                if bufferise is None:
                    debut = texte.lstrip()[:12]
                    bufferise = debut.startswith(("```", "{", "[", "<tool_call"))
                if not bufferise:
                    yield {"type": "token", "t": contenu}
            for tc in message.get("tool_calls") or []:
                fn = tc.get("function") or {}
                appels.append({
                    "id": uuid.uuid4().hex[:9],
                    "type": "function",
                    "function": {
                        "name": fn.get("name", ""),
                        "arguments": json.dumps(fn.get("arguments") or {}, ensure_ascii=False),
                    },
                })
            if d.get("done"):
                conv["usage"]["entree"] += d.get("prompt_eval_count") or 0
                conv["usage"]["sortie"] += d.get("eval_count") or 0
    # Repli : appel d'outil écrit en texte plutôt qu'en tool_calls natifs.
    if not appels and bufferise:
        appels = parser_appels_texte(texte)
        if appels:
            texte = ""  # c'était un appel d'outil, pas une réponse à afficher
        else:
            yield {"type": "token", "t": texte}  # finalement du texte : on l'affiche
    return texte, appels


def tour_compat(client_compat, conv, modele):
    """Streame un tour via une API compatible OpenAI (Groq, Gemini). Même
    contrat de sortie que tour_mistral : (texte, appels)."""
    texte = ""
    appels = []
    flux = client_compat.chat.completions.create(
        model=modele,
        messages=[{"role": "system", "content": SYSTEM_PROMPT}] + conv["messages"],
        tools=outils_definitions,
        tool_choice="auto",
        stream=True,
        stream_options={"include_usage": True},
    )
    for chunk in flux:
        if stop_flag["on"]:
            break
        usage = getattr(chunk, "usage", None)
        if usage is not None:
            conv["usage"]["entree"] += getattr(usage, "prompt_tokens", 0) or 0
            conv["usage"]["sortie"] += getattr(usage, "completion_tokens", 0) or 0
        if not getattr(chunk, "choices", None):
            continue
        delta = chunk.choices[0].delta
        contenu = getattr(delta, "content", None)
        if contenu:
            texte += contenu
            yield {"type": "token", "t": contenu}
        for tc in (getattr(delta, "tool_calls", None) or []):
            idx = tc.index if isinstance(getattr(tc, "index", None), int) else max(0, len(appels) - 1)
            while len(appels) <= idx:
                appels.append({"id": None, "type": "function",
                               "function": {"name": "", "arguments": ""}})
            a = appels[idx]
            if getattr(tc, "id", None):
                a["id"] = tc.id
            fn = getattr(tc, "function", None)
            if fn is not None:
                if getattr(fn, "name", None):
                    a["function"]["name"] = fn.name
                if getattr(fn, "arguments", None):
                    a["function"]["arguments"] += fn.arguments
    for a in appels:
        if not a["id"]:
            a["id"] = uuid.uuid4().hex[:9]
    return texte, appels


def tour_modele(conv):
    modele = conv.get("modele") or MODELE_DEFAUT
    fournisseur, _, nom = modele.partition(":")
    if fournisseur == "ollama":
        return (yield from tour_ollama(conv, nom))
    if fournisseur == "groq":
        if not groq_client:
            raise RuntimeError("Clé Groq absente : ajoute GROQ_API_KEY dans le .env")
        return (yield from tour_compat(groq_client, conv, nom))
    if fournisseur == "gemini":
        if not gemini_client:
            raise RuntimeError("Clé Gemini absente : ajoute GEMINI_API_KEY dans le .env")
        return (yield from tour_compat(gemini_client, conv, nom))
    return (yield from tour_mistral(conv, nom or modele))


# ---------------------------------------------------------------------------
# Boucle de l'agent (streaming)
# ---------------------------------------------------------------------------

def cible_outil(nom, args):
    """Petit libellé affiché dans la chip d'activité du front."""
    if nom == "renommer":
        src, dst = args.get("source") or "", args.get("destination") or ""
        return f"{src} → {dst}" if src or dst else ""
    return (args.get("chemin") or args.get("commande")
            or args.get("motif") or args.get("dossier") or "")


def calculer_diff(ws, chemin_rel, nouveau):
    """Diff unifié entre le fichier actuel et le contenu proposé."""
    cible = tools.resoudre(ws, chemin_rel or "")
    try:
        if cible and os.path.isfile(cible):
            with open(cible, "r", encoding="utf-8") as f:
                ancien = f.read().splitlines()
        else:
            ancien = []
    except Exception:
        return None
    diff = list(difflib.unified_diff(
        ancien, (nouveau or "").splitlines(),
        fromfile=f"{chemin_rel} (actuel)", tofile=f"{chemin_rel} (proposé)", lineterm=""))
    return "\n".join(diff) if diff else None


def diff_remplacement(ws, args):
    """Diff prévisionnel d'un remplacer_texte."""
    cible = tools.resoudre(ws, args.get("chemin") or "")
    if not cible or not os.path.isfile(cible):
        return None
    try:
        with open(cible, "r", encoding="utf-8") as f:
            contenu = f.read()
    except Exception:
        return None
    ancien_txt = args.get("ancien") or ""
    if not ancien_txt or ancien_txt not in contenu:
        return None
    propose = contenu.replace(ancien_txt, args.get("nouveau") or "")
    return calculer_diff(ws, args.get("chemin"), propose)


def executer_outil(conv, tc, args, ws):
    """Exécute un tool_call (dict) et ajoute son résultat à la conversation."""
    nom = tc["function"]["name"]
    fonction = fonctions_disponibles.get(nom)
    try:
        resultat = str(fonction(**args, base=ws)) if fonction else f"Outil inconnu : {nom}"
    except TypeError as e:
        resultat = f"Erreur d'arguments : {e}"
    if len(resultat) > 30000:
        resultat = resultat[:30000] + "\n[... résultat tronqué ...]"
    conv["messages"].append({
        "role": "tool",
        "name": nom,
        "content": resultat,
        "tool_call_id": tc["id"],
    })


def continuer(conv):
    """Générateur central : fait avancer l'agent en émettant des événements
    NDJSON jusqu'à une réponse finale, une confirmation ou un arrêt."""
    global en_attente
    ws = base_travail(conv)
    try:
        while True:
            # 1. Traiter les tool_calls en cours s'il y en a.
            if en_attente and en_attente.get("conv") == conv["id"]:
                appels = en_attente["tool_calls"]
                while en_attente["index"] < len(appels):
                    if stop_flag["on"]:
                        break
                    tc = appels[en_attente["index"]]
                    nom = tc["function"]["name"]
                    try:
                        args = json.loads(tc["function"]["arguments"] or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    if nom in OUTILS_SENSIBLES and not en_attente.get("confirme"):
                        charge = {"type": "confirmation", "outil": nom, "arguments": args}
                        if nom == "ecrire_fichier":
                            charge["diff"] = calculer_diff(ws, args.get("chemin"),
                                                           args.get("contenu"))
                        elif nom == "remplacer_texte":
                            charge["diff"] = diff_remplacement(ws, args)
                        sauvegarder_conv(conv)
                        yield charge
                        return
                    en_attente["confirme"] = False
                    evenement = {"type": "outil", "nom": nom, "cible": cible_outil(nom, args)}
                    ident = sauvegarder_avant(nom, args, ws)
                    if ident:
                        evenement["annulation"] = ident
                    yield evenement
                    executer_outil(conv, tc, args, ws)
                    en_attente["index"] += 1
                if en_attente["index"] >= len(appels):
                    en_attente = None
                sauvegarder_conv(conv)

            # 2. Arrêt demandé : on solde ce qui reste et on termine.
            if stop_flag["on"]:
                solder_attente()
                sauvegarder_conv(conv)
                yield {"type": "fin", "usage": conv["usage"], "arret": True}
                return

            # 3. Nouveau tour du modèle (streamé).
            texte, appels = yield from tour_modele(conv)
            message = {"role": "assistant", "content": texte}
            if appels:
                message["tool_calls"] = appels
            conv["messages"].append(message)
            sauvegarder_conv(conv)
            if not appels:
                yield {"type": "fin", "usage": conv["usage"]}
                return
            en_attente = {"conv": conv["id"], "tool_calls": appels,
                          "index": 0, "confirme": False}
    except Exception as e:
        en_attente = None
        sauvegarder_conv(conv)
        yield {"type": "erreur", "message": str(e)}


def reponse_ndjson(generateur):
    def encoder():
        for evenement in generateur:
            yield json.dumps(evenement, ensure_ascii=False) + "\n"
    return Response(encoder(), mimetype="application/x-ndjson",
                    headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


# ---------------------------------------------------------------------------
# Routes : pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/sw.js")
def service_worker():
    return send_from_directory("static", "sw.js", mimetype="application/javascript")


# ---------------------------------------------------------------------------
# Routes : chat (streaming NDJSON)
# ---------------------------------------------------------------------------

@app.route("/api/chat", methods=["POST"])
def api_chat():
    donnees = request.json or {}
    texte = (donnees.get("message") or "").strip()
    if not texte:
        return jsonify({"erreur": "Message vide"}), 400

    stop_flag["on"] = False
    solder_attente()  # une confirmation ignorée = abandonnée

    conv = charger_conv(donnees.get("conversation") or "") or nouvelle_conv()
    nettoyer_conv(conv)
    conv["messages"].append({"role": "user", "content": texte})
    if conv["titre"] == "Nouvelle conversation":
        conv["titre"] = texte[:48] + ("…" if len(texte) > 48 else "")
    sauvegarder_conv(conv)

    def generer():
        yield {"type": "conversation", "id": conv["id"], "titre": conv["titre"]}
        try:
            if compacter(conv):
                yield {"type": "compaction"}
        except Exception:
            pass
        yield from continuer(conv)

    return reponse_ndjson(generer())


@app.route("/api/confirmer", methods=["POST"])
def api_confirmer():
    global en_attente
    if en_attente is None:
        return reponse_ndjson(iter([{"type": "fin", "usage": {"entree": 0, "sortie": 0}}]))

    stop_flag["on"] = False
    conv = charger_conv(en_attente["conv"])
    if conv is None:
        en_attente = None
        return reponse_ndjson(iter([{"type": "erreur", "message": "Conversation introuvable"}]))

    decision = (request.json or {}).get("decision", "non")
    if decision == "oui":
        en_attente["confirme"] = True
    else:
        tc = en_attente["tool_calls"][en_attente["index"]]
        conv["messages"].append({
            "role": "tool",
            "name": tc["function"]["name"],
            "content": "Action refusée par l'utilisateur",
            "tool_call_id": tc["id"],
        })
        en_attente["index"] += 1
        sauvegarder_conv(conv)

    return reponse_ndjson(continuer(conv))


@app.route("/api/stop", methods=["POST"])
def api_stop():
    stop_flag["on"] = True
    return jsonify({"ok": True})


@app.route("/api/annuler", methods=["POST"])
def api_annuler():
    ident = (request.json or {}).get("id", "")
    ok, message = annuler_modification(ident)
    return jsonify({"ok": ok, "message": message})


# ---------------------------------------------------------------------------
# Routes : configuration et modèles
# ---------------------------------------------------------------------------

@app.route("/api/config")
def api_config():
    return jsonify(charger_config())


@app.route("/api/config", methods=["POST"])
def api_config_maj():
    donnees = request.json or {}
    config = charger_config()
    ws = donnees.get("workspace")
    if ws and os.path.isdir(ws):
        config["workspace"] = os.path.abspath(ws)
    if donnees.get("modele"):
        config["modele"] = donnees["modele"]
    sauver_config(config)
    return jsonify(config)


def lister_modeles_compat(api_key, url_models, candidats, exclus, prefixe, etiquette):
    """Modèles disponibles sur une API compatible OpenAI (recommandés d'abord).
    Vide si aucune clé. Robuste aux renommages : filtré par /models réel."""
    if not api_key:
        return []
    try:
        requete = urllib.request.Request(
            url_models, headers={"Authorization": f"Bearer {api_key}"})
        with urllib.request.urlopen(requete, timeout=4) as r:
            dispos = {(m.get("id") or "").split("/")[-1] for m in json.load(r).get("data", [])}
    except Exception:
        # Clé présente mais liste inaccessible : proposer les candidats connus.
        return [{"id": prefixe + ":" + mid, "nom": nom} for mid, nom in candidats]
    labels = dict(candidats)
    modeles = [{"id": prefixe + ":" + mid, "nom": nom}
               for mid, nom in candidats if mid in dispos]
    for mid in sorted(dispos):
        if mid in labels or any(x in mid.lower() for x in exclus):
            continue
        modeles.append({"id": prefixe + ":" + mid, "nom": mid + " · " + etiquette})
    return modeles[:10]


def modeles_groq():
    return lister_modeles_compat(
        GROQ_API_KEY, "https://api.groq.com/openai/v1/models",
        GROQ_CANDIDATS, GROQ_EXCLUS, "groq", "Groq")


def modeles_gemini():
    return lister_modeles_compat(
        GEMINI_API_KEY, "https://generativelanguage.googleapis.com/v1beta/openai/models",
        GEMINI_CANDIDATS, GEMINI_EXCLUS, "gemini", "Google")


@app.route("/api/modeles")
def api_modeles():
    modeles = list(MODELES_MISTRAL) + modeles_groq() + modeles_gemini()
    try:
        with urllib.request.urlopen(OLLAMA_URL + "/api/tags", timeout=1.5) as r:
            tags = json.load(r)
        for m in tags.get("models", []):
            nom = m.get("name", "")
            if nom:
                modeles.append({"id": "ollama:" + nom, "nom": nom + " · local"})
    except Exception:
        pass  # Ollama non installé ou éteint
    return jsonify({"modeles": modeles})


@app.route("/api/dossiers")
def api_dossiers():
    """Navigation dans les dossiers du disque (pour choisir le workspace)."""
    chemin = request.args.get("chemin", "")
    if not chemin:
        lecteurs = [f"{lettre}:\\" for lettre in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                    if os.path.exists(f"{lettre}:\\")]
        return jsonify({"chemin": "", "parent": None,
                        "dossiers": [{"nom": l, "chemin": l} for l in lecteurs]})
    chemin = os.path.abspath(chemin)
    if not os.path.isdir(chemin):
        return jsonify({"erreur": "Dossier invalide"}), 400
    dossiers = []
    try:
        for nom in sorted(os.listdir(chemin), key=str.lower):
            complet = os.path.join(chemin, nom)
            if nom.startswith("$") or nom in {"System Volume Information"}:
                continue
            try:
                if os.path.isdir(complet):
                    dossiers.append({"nom": nom, "chemin": complet})
            except OSError:
                continue
    except PermissionError:
        return jsonify({"erreur": "Accès refusé"}), 403
    parent = os.path.dirname(chemin.rstrip("\\/"))
    if parent == chemin or not parent:
        parent = ""
    return jsonify({"chemin": chemin, "parent": parent, "dossiers": dossiers})


# ---------------------------------------------------------------------------
# Navigateur de disque (explorateur libre) + accès réseau
# ---------------------------------------------------------------------------

@app.route("/api/parcourir")
def api_parcourir():
    """Parcourt n'importe quel chemin absolu du disque : dossiers ET fichiers
    (la liste des lecteurs si le chemin est vide). Sert l'explorateur, qui
    permet de se balader partout sur le PC — indépendamment du dossier de
    travail de l'agent (lui reste confiné, voir tools_web.resoudre)."""
    chemin = request.args.get("chemin", "")
    if not chemin:
        lecteurs = [f"{lettre}:\\" for lettre in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                    if os.path.exists(f"{lettre}:\\")]
        return jsonify({"chemin": "", "parent": None, "racine": True,
                        "entrees": [{"nom": l, "chemin": l, "type": "dossier"} for l in lecteurs]})
    chemin = os.path.abspath(chemin)
    if not os.path.isdir(chemin):
        return jsonify({"erreur": "Dossier invalide"}), 400
    dossiers, fichiers = [], []
    try:
        for nom in sorted(os.listdir(chemin), key=str.lower):
            if nom.startswith("$") or nom == "System Volume Information":
                continue
            complet = os.path.join(chemin, nom)
            try:
                (dossiers if os.path.isdir(complet) else fichiers).append(
                    {"nom": nom, "chemin": complet,
                     "type": "dossier" if os.path.isdir(complet) else "fichier"})
            except OSError:
                continue
    except PermissionError:
        return jsonify({"erreur": "Accès refusé"}), 403
    depouille = chemin.rstrip("\\/")
    parent = os.path.dirname(depouille)
    if not parent or parent == depouille:
        parent = ""  # racine d'un lecteur : remonter vers la liste des lecteurs
    return jsonify({"chemin": chemin, "parent": parent, "racine": False,
                    "entrees": dossiers + fichiers})


@app.route("/api/apercu")
def api_apercu():
    """Aperçu lecture seule d'un fichier texte n'importe où sur le disque
    (taille limitée). Complète /api/fichier, qui reste confiné au workspace."""
    chemin = request.args.get("chemin", "")
    if not chemin or not os.path.isfile(chemin):
        return jsonify({"erreur": "Fichier invalide"}), 400
    try:
        if os.path.getsize(chemin) > 1_000_000:
            return jsonify({"erreur": "Fichier trop volumineux (> 1 Mo)"}), 400
        with open(chemin, "r", encoding="utf-8") as f:
            contenu = f.read()
    except UnicodeDecodeError:
        return jsonify({"erreur": "Fichier binaire, non affichable"}), 400
    except Exception as e:
        return jsonify({"erreur": f"Lecture impossible : {e}"}), 400
    return jsonify({"chemin": chemin, "nom": os.path.basename(chemin), "contenu": contenu})


@app.route("/api/cle-locale")
def api_cle_locale():
    """Remet le jeton d'accès, mais uniquement à la machine locale : le PC
    n'a donc rien à saisir, le téléphone passe par le lien ?cle=…"""
    if not est_local():
        abort(403)
    return jsonify({"cle": CLE_API})


@app.route("/api/reseau")
def api_reseau():
    """Infos pour ouvrir l'appli sur le téléphone (même Wi-Fi)."""
    ip = ip_locale()
    port = int(os.getenv("PORT", "5000"))
    ouvert = (os.getenv("HOST", "127.0.0.1") == "0.0.0.0")
    return jsonify({
        "ip": ip, "port": port, "ouvert_reseau": ouvert,
        "url": f"http://{ip}:{port}/?cle={CLE_API}" if ip else None,
    })


@app.route("/api/qr")
def api_qr():
    """QR code (SVG) d'une URL, pour scanner l'accès téléphone. Généré
    localement : aucun service tiers, la clé ne quitte pas le réseau."""
    import io
    url = request.args.get("url", "")
    if not url:
        return jsonify({"erreur": "url manquante"}), 400
    try:
        import qrcode
        import qrcode.image.svg
    except ImportError:
        return jsonify({"erreur": "librairie qrcode non installée"}), 501
    try:
        img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage,
                          box_size=11, border=2)
        buf = io.BytesIO()
        img.save(buf)
        return Response(buf.getvalue(), mimetype="image/svg+xml")
    except Exception as e:
        return jsonify({"erreur": str(e)}), 500


@app.route("/api/quitter", methods=["POST"])
def api_quitter():
    """Arrête le serveur (bouton ⏻ de l'interface). Réservé à la machine locale."""
    if not est_local():
        abort(403)
    import threading

    def _stop():
        time.sleep(0.3)
        os._exit(0)

    threading.Thread(target=_stop, daemon=True).start()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes : conversations
# ---------------------------------------------------------------------------

@app.route("/api/conversations")
def api_conversations():
    return jsonify({"conversations": liste_convs()})


@app.route("/api/conversations", methods=["POST"])
def api_conversations_creer():
    conv = nouvelle_conv()
    return jsonify({"id": conv["id"], "titre": conv["titre"],
                    "workspace": conv["workspace"], "modele": conv["modele"]})


@app.route("/api/conversations/<cid>")
def api_conversation(cid):
    conv = charger_conv(cid)
    if conv is None:
        return jsonify({"erreur": "Conversation introuvable"}), 404
    affichage = []
    for m in conv["messages"]:
        role = m.get("role")
        if role == "user":
            affichage.append({"role": "user", "content": m.get("content", "")})
        elif role == "assistant":
            if m.get("content"):
                affichage.append({"role": "agent", "content": m["content"]})
            for tc in m.get("tool_calls") or []:
                try:
                    args = json.loads(tc["function"]["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                affichage.append({"role": "outil",
                                  "nom": tc["function"]["name"],
                                  "cible": cible_outil(tc["function"]["name"], args)})
    return jsonify({"id": conv["id"], "titre": conv["titre"],
                    "usage": conv["usage"], "messages": affichage,
                    "workspace": conv["workspace"], "modele": conv["modele"]})


@app.route("/api/conversations/<cid>", methods=["DELETE"])
def api_conversation_supprimer(cid):
    global en_attente
    chemin = chemin_conv(cid)
    if chemin and os.path.exists(chemin):
        if en_attente and en_attente.get("conv") == cid:
            en_attente = None
        os.remove(chemin)
        return jsonify({"ok": True})
    return jsonify({"erreur": "Conversation introuvable"}), 404


@app.route("/api/conversations/<cid>", methods=["PATCH"])
def api_conversation_modifier(cid):
    conv = charger_conv(cid)
    if conv is None:
        return jsonify({"erreur": "Conversation introuvable"}), 404
    donnees = request.json or {}
    titre = (donnees.get("titre") or "").strip()
    if titre:
        conv["titre"] = titre[:60]
    ws = donnees.get("workspace")
    if ws and os.path.isdir(ws):
        conv["workspace"] = os.path.abspath(ws)
    if donnees.get("modele"):
        conv["modele"] = donnees["modele"]
    sauvegarder_conv(conv)
    return jsonify({"ok": True, "titre": conv["titre"],
                    "workspace": conv["workspace"], "modele": conv["modele"]})


# ---------------------------------------------------------------------------
# Routes : explorateur de fichiers (suit le dossier de travail)
# ---------------------------------------------------------------------------

def ws_requete():
    """Dossier de travail passé en paramètre d'URL (routes GET)."""
    ws = request.args.get("ws")
    return ws if ws and os.path.isdir(ws) else BASE_DIR


def chemin_sur(base, rel):
    """Résout un chemin relatif et garantit qu'il reste dans `base`."""
    cible = os.path.abspath(os.path.join(base, rel or ""))
    try:
        if os.path.commonpath([os.path.abspath(base), cible]) != os.path.abspath(base):
            return None
    except ValueError:
        return None
    return cible


@app.route("/api/arborescence")
def api_arborescence():
    ws = ws_requete()
    cible = chemin_sur(ws, request.args.get("dossier", ""))
    if not cible or not os.path.isdir(cible):
        return jsonify({"erreur": "Dossier invalide"}), 400
    entrees = []
    for nom in os.listdir(cible):
        if nom in DOSSIERS_IGNORES:
            continue
        chemin_abs = os.path.join(cible, nom)
        est_dossier = os.path.isdir(chemin_abs)
        entrees.append({
            "nom": nom,
            "chemin": os.path.relpath(chemin_abs, ws).replace("\\", "/"),
            "type": "dossier" if est_dossier else "fichier",
        })
    entrees.sort(key=lambda e: (e["type"] != "dossier", e["nom"].lower()))
    return jsonify({"entrees": entrees})


@app.route("/api/fichier")
def api_fichier():
    ws = ws_requete()
    rel = request.args.get("chemin", "")
    cible = chemin_sur(ws, rel)
    if not cible or not os.path.isfile(cible):
        return jsonify({"erreur": "Fichier invalide"}), 400
    if os.path.basename(cible) in DOSSIERS_IGNORES:
        return jsonify({"erreur": "Fichier masqué"}), 403
    if os.path.getsize(cible) > 1_000_000:
        return jsonify({"erreur": "Fichier trop volumineux (> 1 Mo)"}), 400
    try:
        with open(cible, "r", encoding="utf-8") as f:
            contenu = f.read()
    except UnicodeDecodeError:
        return jsonify({"erreur": "Fichier binaire, non affichable"}), 400
    except Exception as e:
        return jsonify({"erreur": f"Lecture impossible : {e}"}), 400
    return jsonify({"chemin": rel, "contenu": contenu})


@app.route("/api/fichier/sauver", methods=["POST"])
def api_fichier_sauver():
    donnees = request.json or {}
    ws = donnees.get("ws")
    ws = ws if ws and os.path.isdir(ws) else BASE_DIR
    rel = donnees.get("chemin", "")
    cible = chemin_sur(ws, rel)
    if not cible or not os.path.isfile(cible):
        return jsonify({"erreur": "Fichier invalide"}), 400
    if os.path.basename(cible) in DOSSIERS_IGNORES:
        return jsonify({"erreur": "Fichier protégé"}), 403
    try:
        with open(cible, "w", encoding="utf-8") as f:
            f.write(donnees.get("contenu", ""))
    except Exception as e:
        return jsonify({"erreur": f"Écriture impossible : {e}"}), 400
    return jsonify({"ok": True})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """Téléverse un fichier directement dans le dossier de travail."""
    ws = request.form.get("ws")
    ws = ws if ws and os.path.isdir(ws) else BASE_DIR
    fichier = request.files.get("fichier")
    if not fichier or not fichier.filename:
        return jsonify({"erreur": "Aucun fichier reçu"}), 400
    nom = secure_filename(fichier.filename) or "fichier_televerse"
    cible = chemin_sur(ws, nom)
    if not cible:
        return jsonify({"erreur": "Nom de fichier invalide"}), 400
    # Évite d'écraser silencieusement un fichier existant : suffixe (1), (2)…
    base, ext = os.path.splitext(cible)
    i = 1
    while os.path.exists(cible):
        cible = f"{base} ({i}){ext}"
        i += 1
    try:
        fichier.save(cible)
    except Exception as e:
        return jsonify({"erreur": f"Enregistrement impossible : {e}"}), 400
    return jsonify({"ok": True, "chemin": os.path.relpath(cible, ws).replace("\\", "/")})


@app.route("/api/telecharger")
def api_telecharger():
    """Renvoie un fichier du dossier de travail en pièce jointe."""
    ws = ws_requete()
    cible = chemin_sur(ws, request.args.get("chemin", ""))
    if not cible or not os.path.isfile(cible):
        return jsonify({"erreur": "Fichier invalide"}), 400
    if os.path.basename(cible) in DOSSIERS_IGNORES:
        return jsonify({"erreur": "Fichier protégé"}), 403
    return send_file(cible, as_attachment=True, download_name=os.path.basename(cible))


@app.errorhandler(413)
def trop_gros(_):
    return jsonify({"erreur": "Fichier trop volumineux (max 15 Mo)"}), 413


migrer_ancien_historique()

if __name__ == "__main__":
    hote = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("DEBUG", "").lower() in ("1", "true", "on", "oui")
    print("=" * 58)
    print("  Cortex — serveur démarré")
    print(f"  Sur ce PC        : http://127.0.0.1:{port}")
    if hote == "0.0.0.0":
        ip = ip_locale()
        if ip:
            print(f"  Sur le téléphone : http://{ip}:{port}/?cle={CLE_API}")
            print("                     (même Wi-Fi ; le lien contient la clé)")
    else:
        print("  (réseau local off — lance avec HOST=0.0.0.0 pour le téléphone)")
    print("=" * 58)
    # debug=False par défaut : le débogueur Werkzeug permet d'exécuter du code
    # arbitraire via le navigateur — à proscrire sur un outil qui touche déjà
    # aux fichiers et au shell. Active-le au besoin avec DEBUG=1.
    app.run(host=hote, port=port, debug=debug, threaded=True)
