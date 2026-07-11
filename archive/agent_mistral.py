import os
import json
from mistralai.client import Mistral
from dotenv import load_dotenv
import tools

load_dotenv()

client = Mistral(api_key=os.getenv("MISTRAL_API_KEY"))

MODEL = "devstral-latest"

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

def demander_a_lia(messages):
    response = client.chat.complete(
        model=MODEL,
        messages=messages,
        tools=outils_definitions,
        tool_choice="auto"
    )
    return response.choices[0].message

if __name__ == "__main__":
    print("=== Mon Agent de Code (Mistral/Devstral) ===")
    messages = []

    while True:
        instruction = input("\nToi : ")
        if instruction.lower() in ["quit", "exit"]:
            break

        messages.append({"role": "user", "content": instruction})
        message = demander_a_lia(messages)

        # Boucle tant que l'IA veut utiliser des outils
        while message.tool_calls:
            messages.append(message)
            for tool_call in message.tool_calls:
                nom_fonction = tool_call.function.name
                arguments = json.loads(tool_call.function.arguments)
                resultat = fonctions_disponibles[nom_fonction](**arguments)
                messages.append({
                    "role": "tool",
                    "name": nom_fonction,
                    "content": str(resultat),
                    "tool_call_id": tool_call.id
                })
            message = demander_a_lia(messages)

        messages.append(message)
        print(f"\nAgent : {message.content}")