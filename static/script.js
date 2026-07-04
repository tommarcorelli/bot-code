const chatDiv = document.getElementById("chat");
const input = document.getElementById("message");
const boutonEnvoyer = document.getElementById("envoyer");

marked.setOptions({ breaks: true });

function scrollBas() { chatDiv.scrollTop = chatDiv.scrollHeight; }

function retirerAccueil() {
  const a = document.getElementById("accueil");
  if (a) a.remove();
}

// Crée une rangée avatar + bulle. Retourne l'élément .bulle.
function creerRangee(classe, avatarTxt) {
  retirerAccueil();
  const rangee = document.createElement("div");
  rangee.className = "rangee " + classe;
  const avatar = document.createElement("div");
  avatar.className = "avatar " + classe;
  avatar.textContent = avatarTxt;
  const bulle = document.createElement("div");
  bulle.className = "bulle";
  rangee.appendChild(avatar);
  rangee.appendChild(bulle);
  chatDiv.appendChild(rangee);
  scrollBas();
  return bulle;
}

function messageUtilisateur(texte) {
  const bulle = creerRangee("moi", "🧑");
  bulle.textContent = texte;
}

// Rendu markdown + coloration + boutons copier.
function messageAgent(texte) {
  const bulle = creerRangee("ia", "🤖");
  bulle.innerHTML = DOMPurify.sanitize(marked.parse(texte || ""));
  embellirCode(bulle);
  scrollBas();
  return bulle;
}

function embellirCode(conteneur) {
  conteneur.querySelectorAll("pre code").forEach((code) => {
    hljs.highlightElement(code);
    const pre = code.parentElement;
    if (pre.parentElement.classList.contains("bloc-code")) return;
    const wrap = document.createElement("div");
    wrap.className = "bloc-code";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement("button");
    btn.className = "copier";
    btn.textContent = "Copier";
    btn.onclick = () => {
      navigator.clipboard.writeText(code.innerText);
      btn.textContent = "Copié ✓";
      setTimeout(() => (btn.textContent = "Copier"), 1400);
    };
    wrap.appendChild(btn);
  });
}

// Indicateur de frappe animé, retourne la rangée à retirer ensuite.
function afficherFrappe() {
  const bulle = creerRangee("ia", "🤖");
  bulle.innerHTML = '<div class="frappe"><span></span><span></span><span></span></div>';
  return bulle.closest(".rangee");
}

function gererReponse(data) {
  if (data.type === "confirmation") {
    afficherConfirmation(data);
  } else {
    messageAgent(data.reponse);
  }
}

function afficherConfirmation(data) {
  retirerAccueil();
  const rangee = document.createElement("div");
  rangee.className = "rangee ia";
  const avatar = document.createElement("div");
  avatar.className = "avatar ia";
  avatar.textContent = "🤖";
  rangee.appendChild(avatar);

  const carte = document.createElement("div");
  carte.className = "confirmation";

  const estCommande = data.outil === "executer_commande";
  const corps = estCommande ? data.arguments.commande : data.arguments.contenu;
  const langue = estCommande ? "bash" : devinerLangue(data.arguments.chemin);

  const titre = document.createElement("div");
  titre.className = "titre";
  titre.innerHTML = `<span class="badge">CONFIRMATION</span> ` +
    (estCommande ? "Exécuter une commande ?" : "Écrire un fichier ?");
  carte.appendChild(titre);

  if (!estCommande) {
    const cible = document.createElement("div");
    cible.className = "cible";
    cible.textContent = "📄 " + data.arguments.chemin;
    carte.appendChild(cible);
  }

  const wrap = document.createElement("div");
  wrap.className = "bloc-code";
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-" + langue;
  code.textContent = corps || "";
  pre.appendChild(code);
  wrap.appendChild(pre);
  carte.appendChild(wrap);
  hljs.highlightElement(code);

  const boutons = document.createElement("div");
  boutons.className = "boutons";
  const btnOui = document.createElement("button");
  btnOui.className = "oui";
  btnOui.textContent = "✓ Confirmer";
  const btnNon = document.createElement("button");
  btnNon.className = "non";
  btnNon.textContent = "✕ Annuler";
  boutons.appendChild(btnNon);
  boutons.appendChild(btnOui);
  carte.appendChild(boutons);

  btnOui.onclick = () => repondreConfirmation("oui", carte);
  btnNon.onclick = () => repondreConfirmation("non", carte);

  rangee.appendChild(carte);
  chatDiv.appendChild(rangee);
  scrollBas();
}

function devinerLangue(chemin) {
  const ext = (chemin || "").split(".").pop().toLowerCase();
  const map = { py: "python", js: "javascript", ts: "typescript", html: "html",
    css: "css", json: "json", md: "markdown", sh: "bash", txt: "plaintext",
    yml: "yaml", yaml: "yaml", sql: "sql", java: "java", c: "c", cpp: "cpp" };
  return map[ext] || "plaintext";
}

async function repondreConfirmation(decision, carte) {
  carte.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const verdict = document.createElement("div");
  verdict.className = "verdict";
  verdict.textContent = decision === "oui" ? "→ Action confirmée" : "→ Action annulée";
  carte.appendChild(verdict);

  const frappe = afficherFrappe();
  try {
    const res = await fetch("/api/confirmer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision })
    });
    const data = await res.json();
    frappe.remove();
    gererReponse(data);
  } catch (e) {
    frappe.remove();
    messageAgent("⚠️ Erreur de connexion au serveur.");
  }
}

async function envoyer() {
  const texte = input.value.trim();
  if (!texte) return;
  messageUtilisateur(texte);
  input.value = "";
  autoTaille();

  const frappe = afficherFrappe();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: texte })
    });
    const data = await res.json();
    frappe.remove();
    gererReponse(data);
  } catch (e) {
    frappe.remove();
    messageAgent("⚠️ Erreur de connexion au serveur.");
  }
}

function autoTaille() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

// Recharge la conversation sauvegardée côté serveur au chargement de la page.
async function chargerFil() {
  try {
    const res = await fetch("/api/historique");
    const data = await res.json();
    if (!data.messages || !data.messages.length) return;
    data.messages.forEach((m) => {
      if (m.role === "user") messageUtilisateur(m.content);
      else messageAgent(m.content);
    });
  } catch (e) { /* pas d'historique, on reste sur l'accueil */ }
}

async function nouvelleConversation() {
  if (!confirm("Démarrer une nouvelle conversation ? L'historique actuel sera effacé.")) return;
  await fetch("/api/nouvelle", { method: "POST" });
  chatDiv.innerHTML = '<div class="vide" id="accueil">' +
    '<h2>👋 Nouvelle conversation</h2>' +
    '<p>Demande-moi de lire, écrire ou exécuter du code. Les actions sensibles te seront soumises pour confirmation.</p></div>';
  input.focus();
}

input.addEventListener("input", autoTaille);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    envoyer();
  }
});
boutonEnvoyer.addEventListener("click", envoyer);
document.getElementById("nouvelle").addEventListener("click", nouvelleConversation);

/* ===== Explorateur de fichiers ===== */
const explorateur = document.getElementById("explorateur");
const voileExp = document.getElementById("voile-exp");
const arbre = document.getElementById("arbre");
const visionneuse = document.getElementById("visionneuse");
let arbreCharge = false;

function iconeFichier(nom) {
  const ext = nom.split(".").pop().toLowerCase();
  const m = { py: "🐍", js: "📜", ts: "📜", html: "🌐", css: "🎨",
    json: "🔧", md: "📝", txt: "📄", env: "🔑", sh: "⚡",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️" };
  return m[ext] || "📄";
}

async function chargerDossier(rel, conteneur) {
  conteneur.innerHTML = '<div class="ligne" style="color:var(--muted)">chargement…</div>';
  try {
    const res = await fetch("/api/arborescence?dossier=" + encodeURIComponent(rel));
    const data = await res.json();
    conteneur.innerHTML = "";
    if (data.erreur) { conteneur.innerHTML = '<div class="ligne">' + data.erreur + '</div>'; return; }
    if (!data.entrees.length) { conteneur.innerHTML = '<div class="ligne" style="color:var(--muted)">(vide)</div>'; return; }
    data.entrees.forEach((e) => conteneur.appendChild(creerNoeud(e)));
  } catch (e) {
    conteneur.innerHTML = '<div class="ligne">Erreur de chargement</div>';
  }
}

function creerNoeud(e) {
  const noeud = document.createElement("div");
  const ligne = document.createElement("div");
  ligne.className = "ligne " + e.type;

  const ico = document.createElement("span");
  ico.className = "ico";
  ico.textContent = e.type === "dossier" ? "📁" : iconeFichier(e.nom);
  const nom = document.createElement("span");
  nom.className = "nom";
  nom.textContent = e.nom;
  ligne.appendChild(ico);
  ligne.appendChild(nom);
  noeud.appendChild(ligne);

  if (e.type === "dossier") {
    const enfants = document.createElement("div");
    enfants.className = "enfants";
    enfants.style.display = "none";
    let charge = false;
    ligne.onclick = async () => {
      const ferme = enfants.style.display === "none";
      enfants.style.display = ferme ? "block" : "none";
      ico.textContent = ferme ? "📂" : "📁";
      if (ferme && !charge) { await chargerDossier(e.chemin, enfants); charge = true; }
    };
    noeud.appendChild(enfants);
  } else {
    ligne.onclick = () => ouvrirFichier(e.chemin);
  }
  return noeud;
}

function basculerExplorateur() {
  const ouvert = explorateur.classList.toggle("ouvert");
  voileExp.classList.toggle("ouvert", ouvert);
  if (ouvert && !arbreCharge) { chargerDossier("", arbre); arbreCharge = true; }
}

async function ouvrirFichier(rel) {
  const titre = visionneuse.querySelector(".v-titre");
  const corps = visionneuse.querySelector(".v-corps");
  titre.textContent = rel;
  corps.innerHTML = '<div style="color:var(--muted);padding:8px">chargement…</div>';
  visionneuse.classList.add("ouvert");
  try {
    const res = await fetch("/api/fichier?chemin=" + encodeURIComponent(rel));
    const data = await res.json();
    corps.innerHTML = "";
    if (data.erreur) { corps.innerHTML = '<div style="color:#f87171;padding:8px">' + data.erreur + '</div>'; return; }
    const wrap = document.createElement("div");
    wrap.className = "bloc-code";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-" + devinerLangue(rel);
    code.textContent = data.contenu;
    pre.appendChild(code);
    wrap.appendChild(pre);
    corps.appendChild(wrap);
    hljs.highlightElement(code);
    visionneuse.querySelector(".v-copier").onclick = () => {
      navigator.clipboard.writeText(data.contenu);
    };
  } catch (e) {
    corps.innerHTML = '<div style="color:#f87171;padding:8px">Erreur de chargement</div>';
  }
}

function fermerVisionneuse() { visionneuse.classList.remove("ouvert"); }

document.getElementById("toggle-fichiers").addEventListener("click", basculerExplorateur);
document.getElementById("rafraichir").addEventListener("click", () => chargerDossier("", arbre));
voileExp.addEventListener("click", basculerExplorateur);
visionneuse.querySelector(".v-fermer").addEventListener("click", fermerVisionneuse);
visionneuse.addEventListener("click", (e) => { if (e.target === visionneuse) fermerVisionneuse(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fermerVisionneuse(); });

chargerFil();

/* ===== PWA : enregistrement du service worker ===== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) =>
      console.warn("Service worker non enregistré :", e)
    );
  });
}
