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
                historique.append(message)
                return {"type": "reponse", "reponse": message.content}
            historique.append(message)
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
        return jsonify(traiter())
    except Exception as e:
        return jsonify({"type": "reponse", "reponse": f"Erreur : {e}"})


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
        return jsonify(traiter())
    except Exception as e:
        en_attente = None
        return jsonify({"type": "reponse", "reponse": f"Erreur : {e}"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
