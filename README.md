# Cortex

**Cortex** est un agent de développement local, dans le navigateur : tu discutes
avec un modèle (Mistral/Devstral, Groq, Gemini ou Ollama) qui **lit, écrit,
cherche et exécute du code** directement dans tes projets — avec confirmation
avant chaque action sensible et annulation en un clic.

C'est un mini « Claude Code » maison : serveur Flask sur ton PC, interface web
installable comme une appli (PWA), y compris sur le téléphone.

---

## Installation (une seule fois)

Double-clique sur **`installer.bat`**. Il crée l'environnement Python, installe
les dépendances et pose **une** icône **Cortex** sur ton bureau.

Puis copie `.env.example` en `.env` et mets au moins ta clé Mistral :

```
MISTRAL_API_KEY=ta_cle_ici
```

Les autres fournisseurs (Groq, Gemini) sont optionnels : sans clé, leurs modèles
n'apparaissent tout simplement pas dans la liste.

> Installation manuelle, au besoin :
> ```
> python -m venv venv
> venv\Scripts\python.exe -m pip install -r requirements.txt
> ```

---

## Lancer l'agent

**Double-clique sur l'icône « Cortex » de ton bureau.** Le serveur démarre
sans fenêtre et le navigateur s'ouvre tout seul. Plus besoin d'aller cliquer sur
un `.bat` dans le dossier.

Une seule icône suffit : elle sert **à la fois sur ce PC et pour le téléphone**
(l'accès Wi-Fi est intégré). Pour **arrêter** : le bouton **⏻** en haut à droite
de l'interface.

| Je veux… | Je lance… |
|---|---|
| L'utiliser (PC et/ou téléphone) | Icône **« Cortex »** |
| Voir la console / les logs | `lancer.bat` |

---

## Sur le téléphone (comme une vraie appli)

Oui, c'est possible — et ça se comporte comme l'appli Claude ou Gemini (icône sur
l'écran d'accueil, plein écran, sans barre de navigateur). À savoir : c'est une
**télécommande** de l'agent qui tourne sur ton PC. Le PC doit donc être allumé et
sur le **même Wi-Fi** (l'agent travaille sur *tes fichiers*, qui sont sur le PC).

1. Lance l'icône **« Cortex »** sur le PC.
2. Dans l'interface, clique le bouton **📱** : un **QR code** s'affiche.
3. Scanne-le avec le téléphone (même Wi-Fi). L'appli s'ouvre.
4. Menu du navigateur → **« Ajouter à l'écran d'accueil »**. Tu obtiens une
   icône d'appli qui lance l'agent en plein écran.

Le lien contient ta **clé d'accès** : garde-le pour toi.

> **Le téléphone ne se connecte pas ?** Lance une fois
> `Ouvrir-acces-telephone.bat` (il demande les droits admin) : il ouvre le port
> 5000 dans le pare-feu Windows et retire les règles qui bloquent `pythonw`.
> Vérifie aussi que le téléphone est bien sur le **même Wi-Fi** que le PC.
>
> **« Via GitHub » ne marche pas** — c'est normal : GitHub ne stocke que le
> *code*, il ne fait pas tourner l'appli. Cortex tourne sur ton PC ; le
> téléphone s'y connecte par le lien Wi-Fi ci-dessus.

> Pour l'utiliser **hors de chez toi** (4G, autre réseau), il faudrait exposer le
> serveur via un tunnel (Cloudflare Tunnel, ngrok…) — possible grâce à la clé
> d'accès, mais non couvert ici.

---

## Sécurité

L'agent peut écrire des fichiers et lancer des commandes : l'API est donc
protégée par un **jeton d'accès** généré au premier lancement (stocké dans
`config.json`).

- Le **PC** récupère le jeton automatiquement (rien à saisir).
- Le **téléphone** le reçoit via le lien `?cle=…` du QR code.
- Toute requête `/api/…` sans jeton valide est refusée (403).
- Les outils fichiers de l'agent restent **confinés au dossier de travail**
  (voir `tools_web.resoudre`). L'explorateur, lui, peut parcourir tout le PC en
  lecture ; les fichiers hors du dossier de travail s'ouvrent en lecture seule.
- Le débogueur Werkzeug est **désactivé** par défaut (`DEBUG=1` pour l'activer,
  en développement uniquement).

---

## Utilisation

- **Dossier de travail** : bouton 📂 dans l'en-tête, ou l'explorateur 🗂️
  (bouton 📌 « Travailler ici »). C'est là que l'agent lit et écrit.
- **Explorateur** (bouton 📁) : un vrai navigateur de disque — remonte, descends,
  ouvre n'importe quel dossier du PC, prévisualise les fichiers.
- **Confirmation** : écriture, remplacement, suppression, renommage et commandes
  shell demandent ton feu vert (avec un aperçu du *diff* pour les fichiers).
- **Annulation** : le bouton ↩ sur une action restaure le fichier d'avant.
- **Pièces jointes** : glisse-dépose des fichiers dans la fenêtre pour les
  ajouter au dossier de travail.

### Outils de l'agent

`lire_fichier`, `lire_extrait` (portion d'un gros fichier), `ecrire_fichier`,
`remplacer_texte`, `renommer` (déplacer/renommer), `supprimer_fichier`,
`creer_dossier`, `lister_fichiers`, `chercher_texte`, `executer_commande`.

### Modèles

- **Mistral** : Devstral (défaut), Codestral, Mistral Small/Large.
- **Groq** et **Gemini** : gratuits, function calling — la liste réelle est
  filtrée selon ce que l'API expose au moment du lancement.
- **Ollama** : modèles locaux (les modèles sans function calling sont pilotés via
  un parsing des appels d'outils dans le texte).

---

## Architecture

```
bot-code/
├── app.py              serveur Flask : routes, tours de modèle, outils, sécurité
├── tools_web.py        outils fichiers (confinés au dossier de travail) + tests couverts
├── agent_mistral.py    version CLI minimale (démo pédagogique, hors interface web)
├── templates/index.html
├── static/
│   ├── script.js       front (chat, streaming, explorateur, PWA, jeton)
│   ├── style.css       design system
│   ├── sw.js           service worker (PWA installable)
│   ├── manifest.json   manifeste PWA (+ icônes maskables)
│   └── icon-*.png
├── tests/              py -m unittest discover -s tests
├── installer.bat       installation + icône bureau
├── Demarrer-agent.vbs  lancement sans console (PC + accès téléphone)
├── lancer.bat          lancement avec console (logs)
└── requirements.txt
```

Données locales (ignorées par git) : `conversations/` (une conversation par
fichier), `sauvegardes/` (journal d'annulation), `config.json` (dossier de
travail, modèle, jeton).

---

## Tests

```
venv\Scripts\python.exe -m unittest discover -s tests
```

Couvre la barrière de sécurité des chemins (`resoudre`), les outils fichiers
(écrire, remplacer, renommer, extrait, recherche, suppression) et le jeton
d'accès de l'API.

---

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `MISTRAL_API_KEY` | — | requise (modèles Mistral) |
| `GROQ_API_KEY` | vide | active les modèles Groq |
| `GEMINI_API_KEY` | vide | active les modèles Gemini |
| `OLLAMA_URL` | `http://localhost:11434` | serveur Ollama local |
| `HOST` | `127.0.0.1` | `0.0.0.0` pour l'accès réseau (téléphone) |
| `PORT` | `5000` | port du serveur |
| `DEBUG` | off | `1` = débogueur Werkzeug (dév uniquement) |
