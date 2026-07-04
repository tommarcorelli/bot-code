import os
import json
from flask import Flask, render_template, request, jsonify
from mistralai.client import Mistral
from dotenv import load_dotenv
import tools_web as tools

load_dotenv()

app = Flask(__name__)

client = Mistral(api_key=os.getenv("MISTRAL_API_KEY"))
MODEL = "devstral-latest"

# Fichier de persistance de la conversation.
FICHIER_HISTORIQUE = "conversations.json"

# Outils qui exigent une confirmation de l'utilisateur avant exécution.
OUTILS_SENSIBLES = {"ecrire_fichier", "executer_commande"}

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
            "description": "Écrit ou remplace le contenu d'un fichier",
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
            "name": "executer_commande",
            "description": "Exécute une commande shell et retourne le résultat",
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
            "description": "Liste les fichiers d'un dossier",
            "parameters": {
                "type": "object",
                "properties": {"dossier": {"type": "string"}},
                "required": []
            }
        }
    }
]

fonctions_disponibles = {
    "lire_fichier": tools.lire_fichier,
    "ecrire_fichier": tools.ecrire_fichier,
    "executer_commande": tools.executer_commande,
    "lister_fichiers": tools.lister_fichiers,
}

# État global (usage local mono-utilisateur).
historique = []
# Quand un outil sensible attend une confirmation, on garde ici la liste de
# tool_calls en cours de traitement et l'index de celui en attente.
en_attente = None


def message_vers_dict(message):
    """Convertit un message Mistral (objet) en dict JSON-sérialisable."""
    d = {"role": message.role, "content": message.content}
    if getattr(message, "tool_calls", None):
        d["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            }
            for tc in message.tool_calls
        ]
    return d


def sauvegarder_historique():
    """Écrit la conversation sur disque (best-effort)."""
    try:
        with open(FICHIER_HISTORIQUE, "w", encoding="utf-8") as f:
            json.dump(historique, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[persistance] Échec sauvegarde : {e}")


def nettoyer_historique():
    """Retire une éventuelle séquence de tool_calls incomplète en fin
    d'historique (ex. serveur arrêté pendant une confirmation en attente)."""
    while historique:
        dernier = historique[-1]
        if dernier.get("role") == "tool":
            historique.pop()
            continue
        if dernier.get("role") == "assistant" and dernier.get("tool_calls"):
            historique.pop()
            continue
        break


def charger_historique():
    """Recharge la conversation depuis le disque au démarrage."""
    global historique
    if not os.path.exists(FICHIER_HISTORIQUE):
        return
    try:
        with open(FICHIER_HISTORIQUE, "r", encoding="utf-8") as f:
            historique = json.load(f)
        nettoyer_historique()
        print(f"[persistance] {len(historique)} messages rechargés.")
    except Exception as e:
        print(f"[persistance] Échec chargement : {e}")
        historique = []


def demander_a_lia(messages):
    response = client.chat.complete(
        model=MODEL,
        messages=messages,
        tools=outils_definitions,
        tool_choice="auto"
    )
    return response.choices[0].message


def executer_outil(tool_call):
    """Exécute un tool_call et ajoute son résultat à l'historique."""
    nom = tool_call.function.name
    arguments = json.loads(tool_call.function.arguments)
    resultat = fonctions_disponibles[nom](**arguments)
    historique.append({
        "role": "tool",
        "name": nom,
        "content": str(resultat),
        "tool_call_id": tool_call.id,
    })


def traiter():
    """Fait avancer l'agent jusqu'à une réponse finale ou une demande de
    confirmation. Reprend automatiquement si `en_attente` est déjà positionné."""
    global en_attente

    while True:
        # Nouveau tour du modèle si rien n'est en attente.
        if en_attente is None:
            message = demander_a_lia(historique)
            if not message.tool_calls:
                historique.append(message_vers_dict(message))
                return {"type": "reponse", "reponse": message.content}
            historique.append(message_vers_dict(message))
            en_attente = {"tool_calls": message.tool_calls, "index": 0}

        # Traiter les tool_calls du message courant, un par un.
        tool_calls = en_attente["tool_calls"]
        while en_attente["index"] < len(tool_calls):
            tool_call = tool_calls[en_attente["index"]]
            nom = tool_call.function.name

            if nom in OUTILS_SENSIBLES:
                # Pause : on rend la main au front pour demander confirmation.
                return {
                    "type": "confirmation",
                    "outil": nom,
                    "arguments": json.loads(tool_call.function.arguments),
                }

            executer_outil(tool_call)
            en_attente["index"] += 1

        # Tous les tool_calls sont traités : on relance un tour du modèle.
        en_attente = None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/chat", methods=["POST"])
def api_chat():
    message_utilisateur = request.json.get("message", "")
    historique.append({"role": "user", "content": message_utilisateur})
    try:
        resultat = traiter()
    except Exception as e:
        resultat = {"type": "reponse", "reponse": f"Erreur : {e}"}
    sauvegarder_historique()
    return jsonify(resultat)


@app.route("/api/confirmer", methods=["POST"])
def api_confirmer():
    global en_attente
    if en_attente is None:
        return jsonify({"type": "reponse", "reponse": "Aucune action en attente."})

    decision = request.json.get("decision", "non")
    tool_call = en_attente["tool_calls"][en_attente["index"]]

    try:
        if decision == "oui":
            executer_outil(tool_call)
        else:
            historique.append({
                "role": "tool",
                "name": tool_call.function.name,
                "content": "Action refusée par l'utilisateur",
                "tool_call_id": tool_call.id,
            })
        en_attente["index"] += 1
        resultat = traiter()
    except Exception as e:
        en_attente = None
        resultat = {"type": "reponse", "reponse": f"Erreur : {e}"}
    sauvegarder_historique()
    return jsonify(resultat)


@app.route("/api/historique")
def api_historique():
    """Renvoie les messages affichables (demandes utilisateur + réponses
    texte de l'agent), pour reconstruire le fil au chargement de la page."""
    messages = []
    for m in historique:
        role = m.get("role")
        if role == "user":
            messages.append({"role": "user", "content": m.get("content", "")})
        elif role == "assistant" and not m.get("tool_calls") and m.get("content"):
            messages.append({"role": "agent", "content": m.get("content", "")})
    return jsonify({"messages": messages})


@app.route("/api/nouvelle", methods=["POST"])
def api_nouvelle():
    """Vide la conversation en cours."""
    global historique, en_attente
    historique = []
    en_attente = None
    sauvegarder_historique()
    return jsonify({"ok": True})


charger_historique()

if __name__ == "__main__":
    app.run(debug=True, port=5000)
