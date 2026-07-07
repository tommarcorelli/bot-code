/* ===== Jeton d'accès (sécurité) =====
   L'API exige un jeton. Sur le PC il est récupéré automatiquement ; sur le
   téléphone il arrive via le lien http://IP:5000/?cle=… puis est mémorisé. */
let CLE = localStorage.getItem("agent_cle") || "";
(function initCle() {
  const params = new URLSearchParams(location.search);
  const depuisUrl = params.get("cle");
  if (depuisUrl) {
    CLE = depuisUrl;
    localStorage.setItem("agent_cle", CLE);
    params.delete("cle");
    const reste = params.toString();
    history.replaceState(null, "", location.pathname + (reste ? "?" + reste : ""));
  }
})();

const fetchNatif = window.fetch.bind(window);
window.fetch = function (url, opts) {
  const u = typeof url === "string" ? url : (url && url.url) || "";
  if (u.startsWith("/api/")) {
    opts = Object.assign({}, opts);
    opts.headers = Object.assign({}, opts.headers, { "X-Cle": CLE });
  }
  return fetchNatif(url, opts);
};

// Récupère le jeton auprès du serveur si on ne l'a pas (marche seulement en local, sur le PC).
async function assurerCle() {
  if (CLE) return true;
  try {
    const r = await fetchNatif("/api/cle-locale");
    if (r.ok) {
      CLE = (await r.json()).cle;
      localStorage.setItem("agent_cle", CLE);
      return true;
    }
  } catch (e) { /* réseau indisponible */ }
  return false;
}

const chatDiv = document.getElementById("chat");
const input = document.getElementById("message");
const boutonEnvoyer = document.getElementById("envoyer");
const listeConvDiv = document.getElementById("liste-conv");
const tokensDiv = document.getElementById("tokens");
const selectModele = document.getElementById("modele");
const wsNom = document.getElementById("ws-nom");

marked.setOptions({ breaks: true });

/* ===== État global ===== */
let convId = null;          // conversation active
let wsActuel = "";          // dossier de travail de la conversation active
let enCours = false;        // une génération est en cours
let abortCtl = null;        // AbortController du fetch streaming
let bulleFlux = null;       // bulle en cours de remplissage (streaming)
let texteFlux = "";         // texte accumulé de la bulle en cours
let renduPrevu = false;     // throttle du rendu markdown
let fichiersJoints = [];    // chemins des fichiers téléversés, en attente d'envoi

function scrollBas() { chatDiv.scrollTop = chatDiv.scrollHeight; }

function retirerAccueil() {
  const a = document.getElementById("accueil");
  if (a) a.remove();
}

function toast(texte) {
  const t = document.getElementById("toast");
  t.textContent = texte;
  t.classList.add("visible");
  setTimeout(() => t.classList.remove("visible"), 2400);
}

function basename(chemin) {
  if (!chemin) return "";
  const parties = chemin.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parties[parties.length - 1] || chemin;
}

// Reflète le dossier de travail courant dans le header et sur l'accueil.
function majDossierPartout() {
  const nom = basename(wsActuel) || "…";
  const el = document.getElementById("ws-nom");
  if (el) el.textContent = nom;
  document.querySelectorAll(".ws-carte-nom").forEach((n) => (n.textContent = nom));
}

/* ===== Rendu des messages ===== */

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

function messageAgent(texte) {
  const bulle = creerRangee("ia", "⚡");
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

/* Chips d'activité : montre chaque outil utilisé par l'agent. */
const ICONES_OUTILS = {
  lire_fichier: "📖", ecrire_fichier: "✏️", remplacer_texte: "🔁",
  executer_commande: "💻", lister_fichiers: "📁", chercher_texte: "🔍",
  creer_dossier: "📂", supprimer_fichier: "🗑️",
};

function groupeTravail() {
  retirerAccueil();
  let groupe = chatDiv.lastElementChild;
  if (!groupe || !groupe.classList.contains("travail")) {
    groupe = document.createElement("div");
    groupe.className = "travail";
    chatDiv.appendChild(groupe);
  }
  return groupe;
}

function chipOutil(nom, cible, annulation) {
  const chip = document.createElement("span");
  chip.className = "chip";
  const icone = ICONES_OUTILS[nom] || "🔧";
  chip.innerHTML = `<span class="c-ico">${icone}</span><span class="c-nom">${nom}</span>` +
    (cible ? `<span class="c-cible"></span>` : "");
  if (cible) chip.querySelector(".c-cible").textContent = cible.length > 60 ? cible.slice(0, 60) + "…" : cible;
  if (annulation) {
    const btn = document.createElement("button");
    btn.className = "c-annuler";
    btn.textContent = "↩";
    btn.title = "Annuler cette modification";
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const res = await fetch("/api/annuler", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: annulation }),
        });
        const data = await res.json();
        toast(data.ok ? "↩ " + data.message : "⚠️ " + data.message);
        if (data.ok) chip.classList.add("annulee");
        else btn.disabled = false;
      } catch (e) { btn.disabled = false; toast("⚠️ Erreur de connexion"); }
    };
    chip.appendChild(btn);
  }
  groupeTravail().appendChild(chip);
  scrollBas();
}

function chipInfo(texte) {
  const chip = document.createElement("span");
  chip.className = "chip info";
  chip.textContent = texte;
  groupeTravail().appendChild(chip);
  scrollBas();
}

/* ===== Streaming ===== */

function majTokens(usage) {
  if (!usage) return;
  const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  tokensDiv.textContent = `↑ ${fmt(usage.entree)} · ↓ ${fmt(usage.sortie)}`;
}

function debutGeneration() {
  enCours = true;
  boutonEnvoyer.textContent = "◼";
  boutonEnvoyer.title = "Arrêter";
  boutonEnvoyer.classList.add("stop");
}

function finGeneration() {
  enCours = false;
  abortCtl = null;
  finaliserBulleFlux();
  boutonEnvoyer.textContent = "➤";
  boutonEnvoyer.title = "Envoyer";
  boutonEnvoyer.classList.remove("stop");
}

function finaliserBulleFlux() {
  if (bulleFlux) {
    bulleFlux.innerHTML = DOMPurify.sanitize(marked.parse(texteFlux || ""));
    embellirCode(bulleFlux);
    bulleFlux.classList.remove("curseur");
    bulleFlux = null;
    texteFlux = "";
  }
}

function rendreFlux() {
  renduPrevu = false;
  if (!bulleFlux) return;
  bulleFlux.innerHTML = DOMPurify.sanitize(marked.parse(texteFlux));
  scrollBas();
}

function evenement(ev) {
  switch (ev.type) {
    case "conversation":
      convId = ev.id;
      chargerConversations();
      break;
    case "compaction":
      chipInfo("🗜 Contexte compacté pour économiser des tokens");
      break;
    case "token":
      if (!bulleFlux) {
        bulleFlux = creerRangee("ia", "⚡");
        bulleFlux.classList.add("curseur");
        texteFlux = "";
      }
      texteFlux += ev.t;
      if (!renduPrevu) {
        renduPrevu = true;
        requestAnimationFrame(rendreFlux);
      }
      break;
    case "outil":
      finaliserBulleFlux();
      chipOutil(ev.nom, ev.cible, ev.annulation);
      break;
    case "confirmation":
      finaliserBulleFlux();
      afficherConfirmation(ev);
      finGeneration();
      break;
    case "fin":
      majTokens(ev.usage);
      if (ev.arret) messageAgent("⏹ *Génération arrêtée.*");
      finGeneration();
      break;
    case "erreur":
      finGeneration();
      messageAgent("⚠️ Erreur : " + ev.message);
      break;
  }
}

async function traiterFlux(reponse) {
  const lecteur = reponse.body.getReader();
  const decodeur = new TextDecoder();
  let tampon = "";
  while (true) {
    const { done, value } = await lecteur.read();
    if (done) break;
    tampon += decodeur.decode(value, { stream: true });
    let idx;
    while ((idx = tampon.indexOf("\n")) >= 0) {
      const ligne = tampon.slice(0, idx).trim();
      tampon = tampon.slice(idx + 1);
      if (!ligne) continue;
      try { evenement(JSON.parse(ligne)); }
      catch (e) { console.warn("Ligne NDJSON invalide :", ligne); }
    }
  }
}

async function requeteStream(url, corps) {
  debutGeneration();
  abortCtl = new AbortController();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corps),
      signal: abortCtl.signal,
    });
    await traiterFlux(res);
  } catch (e) {
    if (e.name !== "AbortError") messageAgent("⚠️ Erreur de connexion au serveur.");
  }
  finGeneration();
}

async function envoyer() {
  const texte = input.value.trim();
  if ((!texte && !fichiersJoints.length) || enCours) return;
  let aEnvoyer = texte;
  if (fichiersJoints.length) {
    const liste = fichiersJoints.join(", ");
    aEnvoyer = (texte ? texte + "\n\n" : "") +
      `(Fichiers que je viens d'ajouter dans le dossier de travail : ${liste})`;
  }
  messageUtilisateur(texte || "📎 " + fichiersJoints.join(", "));
  input.value = "";
  fichiersJoints = [];
  document.getElementById("pieces-jointes").innerHTML = "";
  autoTaille();
  await requeteStream("/api/chat", { message: aEnvoyer, conversation: convId });
}

async function arreter() {
  try { await fetch("/api/stop", { method: "POST" }); } catch (e) {}
  if (abortCtl) abortCtl.abort();
  finGeneration();
}

/* ===== Confirmation d'action sensible ===== */

const TITRES_CONFIRMATION = {
  executer_commande: "Exécuter une commande ?",
  ecrire_fichier: "Écrire un fichier ?",
  remplacer_texte: "Modifier un fichier ?",
  supprimer_fichier: "Supprimer un fichier ?",
};

function afficherConfirmation(data) {
  retirerAccueil();
  const rangee = document.createElement("div");
  rangee.className = "rangee ia";
  const avatar = document.createElement("div");
  avatar.className = "avatar ia";
  avatar.textContent = "⚡";
  rangee.appendChild(avatar);

  const carte = document.createElement("div");
  carte.className = "confirmation";

  const titre = document.createElement("div");
  titre.className = "titre";
  titre.innerHTML = `<span class="badge">CONFIRMATION</span> ` +
    (TITRES_CONFIRMATION[data.outil] || "Autoriser cette action ?");
  carte.appendChild(titre);

  if (data.arguments.chemin) {
    const cible = document.createElement("div");
    cible.className = "cible";
    cible.textContent = "📄 " + data.arguments.chemin;
    carte.appendChild(cible);
  }

  if ((data.outil === "ecrire_fichier" || data.outil === "remplacer_texte") && data.diff) {
    carte.appendChild(rendreDiff(data.diff));
  } else if (data.outil === "remplacer_texte") {
    // Pas de diff calculable (texte introuvable ?) : afficher ancien → nouveau.
    const wrap = document.createElement("div");
    wrap.className = "bloc-code diff";
    const pre = document.createElement("pre");
    (data.arguments.ancien || "").split("\n").forEach((l) => {
      const d = document.createElement("div");
      d.className = "d-moins"; d.textContent = "- " + l; pre.appendChild(d);
    });
    (data.arguments.nouveau || "").split("\n").forEach((l) => {
      const d = document.createElement("div");
      d.className = "d-plus"; d.textContent = "+ " + l; pre.appendChild(d);
    });
    wrap.appendChild(pre);
    carte.appendChild(wrap);
  } else if (data.outil !== "supprimer_fichier") {
    const estCommande = data.outil === "executer_commande";
    const corps = estCommande ? data.arguments.commande : data.arguments.contenu;
    const langue = estCommande ? "bash" : devinerLangue(data.arguments.chemin);
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
  }

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

/* Rendu coloré d'un diff unifié. */
function rendreDiff(diff) {
  const wrap = document.createElement("div");
  wrap.className = "bloc-code diff";
  const pre = document.createElement("pre");
  diff.split("\n").forEach((ligne) => {
    const div = document.createElement("div");
    if (ligne.startsWith("+++") || ligne.startsWith("---")) div.className = "d-meta";
    else if (ligne.startsWith("@@")) div.className = "d-hunk";
    else if (ligne.startsWith("+")) div.className = "d-plus";
    else if (ligne.startsWith("-")) div.className = "d-moins";
    else div.className = "d-ctx";
    div.textContent = ligne || " ";
    pre.appendChild(div);
  });
  wrap.appendChild(pre);
  return wrap;
}

async function repondreConfirmation(decision, carte) {
  if (enCours) return;
  carte.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const verdict = document.createElement("div");
  verdict.className = "verdict";
  verdict.textContent = decision === "oui" ? "→ Action confirmée" : "→ Action annulée";
  carte.appendChild(verdict);
  await requeteStream("/api/confirmer", { decision });
}

function devinerLangue(chemin) {
  const ext = (chemin || "").split(".").pop().toLowerCase();
  const map = { py: "python", js: "javascript", ts: "typescript", html: "html",
    css: "css", json: "json", md: "markdown", sh: "bash", bat: "dos", txt: "plaintext",
    yml: "yaml", yaml: "yaml", sql: "sql", java: "java", c: "c", cpp: "cpp" };
  return map[ext] || "plaintext";
}

/* ===== Conversations (sidebar) ===== */

async function chargerConversations() {
  try {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    listeConvDiv.innerHTML = "";
    data.conversations.forEach((c) => {
      const item = document.createElement("div");
      item.className = "conv-item" + (c.id === convId ? " active" : "");
      const titre = document.createElement("span");
      titre.className = "conv-titre";
      titre.textContent = c.titre;
      const meta = document.createElement("span");
      meta.className = "conv-meta";
      meta.textContent = c.nb + " msg";
      const suppr = document.createElement("button");
      suppr.className = "conv-suppr";
      suppr.textContent = "🗑";
      suppr.title = "Supprimer";
      suppr.onclick = (e) => { e.stopPropagation(); supprimerConversation(c.id, c.titre); };
      item.appendChild(titre);
      item.appendChild(meta);
      item.appendChild(suppr);
      item.onclick = () => ouvrirConversation(c.id);
      item.ondblclick = () => renommerConversation(c.id, c.titre);
      listeConvDiv.appendChild(item);
    });
  } catch (e) { /* serveur injoignable */ }
}

function accueilHTML(titre) {
  const nom = basename(wsActuel) || "…";
  return '<div class="vide" id="accueil"><h2>' + titre + '</h2>' +
    '<p>Voici le dossier dans lequel l\'agent travaille. Change-le quand tu veux.</p>' +
    '<button type="button" class="ws-carte ws-changer">' +
    '<span class="ws-carte-ico">📂</span>' +
    '<span class="ws-carte-txt">L\'agent travaille dans <b class="ws-carte-nom">' + nom + '</b></span>' +
    '<span class="ws-carte-action">Changer de dossier</span></button></div>';
}

function appliquerConv(data) {
  convId = data.id;
  if (data.workspace) {
    wsActuel = data.workspace;
    majDossierPartout();
    rafraichirExplorateurSiOuvert();  // l'explorateur suit le nouveau dossier
  }
  if (data.modele && selectModele.querySelector(`option[value="${data.modele}"]`)) {
    selectModele.value = data.modele;
  }
}

async function ouvrirConversation(id) {
  if (enCours) return;
  try {
    const res = await fetch("/api/conversations/" + id);
    if (!res.ok) return;
    const data = await res.json();
    appliquerConv(data);
    chatDiv.innerHTML = "";
    if (!data.messages.length) chatDiv.innerHTML = accueilHTML("👋 Nouvelle conversation");
    data.messages.forEach((m) => {
      if (m.role === "user") messageUtilisateur(m.content);
      else if (m.role === "agent") messageAgent(m.content);
      else if (m.role === "outil") chipOutil(m.nom, m.cible);
    });
    majTokens(data.usage);
    chargerConversations();
    fermerConvMobile();
    input.focus();
  } catch (e) { /* ignore */ }
}

async function nouvelleConversation() {
  if (enCours) return;
  try {
    const res = await fetch("/api/conversations", { method: "POST" });
    const data = await res.json();
    appliquerConv(data);
    chatDiv.innerHTML = accueilHTML("👋 Nouvelle conversation");
    tokensDiv.textContent = "";
    chargerConversations();
    fermerConvMobile();
    input.focus();
  } catch (e) { /* ignore */ }
}

async function supprimerConversation(id, titre) {
  if (!confirm(`Supprimer « ${titre} » ?`)) return;
  await fetch("/api/conversations/" + id, { method: "DELETE" });
  if (id === convId) {
    convId = null;
    chatDiv.innerHTML = accueilHTML("👋 Prêt à coder");
    tokensDiv.textContent = "";
  }
  chargerConversations();
}

async function renommerConversation(id, ancien) {
  const titre = prompt("Nouveau titre :", ancien);
  if (!titre || titre === ancien) return;
  await fetch("/api/conversations/" + id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ titre }),
  });
  chargerConversations();
}

async function patchConv(champs) {
  if (!convId) return;
  await fetch("/api/conversations/" + convId, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(champs),
  });
}

/* ===== Modèles ===== */

async function chargerModeles() {
  try {
    const res = await fetch("/api/modeles");
    const data = await res.json();
    selectModele.innerHTML = "";
    data.modeles.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.nom;
      selectModele.appendChild(opt);
    });
  } catch (e) { /* ignore */ }
}

selectModele.addEventListener("change", async () => {
  const modele = selectModele.value;
  await patchConv({ modele });
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modele }),
  });
  toast("Modèle : " + selectModele.selectedOptions[0].textContent);
});

/* ===== Sélecteur de dossier de travail ===== */

const modalDossier = document.getElementById("modal-dossier");
const dChemin = document.getElementById("d-chemin");
const dListe = document.getElementById("d-liste");
let dossierCourant = "";

async function chargerDossiers(chemin) {
  dListe.innerHTML = '<div class="ligne" style="color:var(--muted)">chargement…</div>';
  try {
    const res = await fetch("/api/dossiers?chemin=" + encodeURIComponent(chemin || ""));
    const data = await res.json();
    if (data.erreur) { dListe.innerHTML = '<div class="ligne">' + data.erreur + '</div>'; return; }
    dossierCourant = data.chemin;
    dChemin.textContent = data.chemin || "Poste de travail";
    dListe.innerHTML = "";
    if (data.chemin) {
      const retour = document.createElement("div");
      retour.className = "ligne dossier";
      retour.innerHTML = '<span class="ico">⬆️</span><span class="nom">..</span>';
      retour.onclick = () => chargerDossiers(data.parent || "");
      dListe.appendChild(retour);
    }
    data.dossiers.forEach((d) => {
      const ligne = document.createElement("div");
      ligne.className = "ligne dossier";
      ligne.innerHTML = '<span class="ico">📁</span><span class="nom"></span>';
      ligne.querySelector(".nom").textContent = d.nom;
      ligne.onclick = () => chargerDossiers(d.chemin);
      dListe.appendChild(ligne);
    });
  } catch (e) {
    dListe.innerHTML = '<div class="ligne">Erreur de chargement</div>';
  }
}

function ouvrirModalDossier() {
  modalDossier.classList.add("ouvert");
  chargerDossiers(wsActuel || "");
}
document.getElementById("ws-btn").addEventListener("click", ouvrirModalDossier);

document.getElementById("d-choisir").addEventListener("click", async () => {
  if (!dossierCourant) { toast("Choisis un dossier (pas la liste des lecteurs)"); return; }
  wsActuel = dossierCourant;
  majDossierPartout();
  rafraichirExplorateurSiOuvert();
  await patchConv({ workspace: wsActuel });
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: wsActuel }),
  });
  modalDossier.classList.remove("ouvert");
  toast("📂 Dossier de travail : " + basename(wsActuel));
});

/* ===== Panneau Git ===== */

const modalGit = document.getElementById("modal-git");

async function chargerGit() {
  const brancheSpan = document.getElementById("g-branche");
  const nonRepo = document.getElementById("g-non-repo");
  const contenu = document.getElementById("g-contenu");
  const pied = document.getElementById("g-pied");
  const fichiersDiv = document.getElementById("g-fichiers");
  const diffDiv = document.getElementById("g-diff");
  brancheSpan.textContent = "…";
  fichiersDiv.innerHTML = "";
  diffDiv.innerHTML = "";
  try {
    const res = await fetch("/api/git/statut?ws=" + encodeURIComponent(wsActuel));
    const data = await res.json();
    if (data.erreur) { brancheSpan.textContent = "erreur"; toast("⚠️ " + data.erreur); return; }
    if (!data.repo) {
      brancheSpan.textContent = "pas de dépôt";
      nonRepo.style.display = "";
      contenu.style.display = "none";
      pied.style.display = "none";
      return;
    }
    nonRepo.style.display = "none";
    contenu.style.display = "";
    pied.style.display = "";
    brancheSpan.textContent = data.branche;
    if (!data.fichiers.length) {
      fichiersDiv.innerHTML = '<div class="g-propre">✓ Aucun changement — dépôt propre</div>';
      return;
    }
    data.fichiers.forEach((f) => {
      const ligne = document.createElement("div");
      ligne.className = "g-fichier";
      const etat = document.createElement("span");
      etat.className = "g-etat e-" + (f.etat === "??" ? "nouveau" : f.etat[0].toLowerCase());
      etat.textContent = f.etat;
      const nom = document.createElement("span");
      nom.className = "g-nom";
      nom.textContent = f.chemin;
      ligne.appendChild(etat);
      ligne.appendChild(nom);
      if (f.etat !== "??") {
        const restaurer = document.createElement("button");
        restaurer.className = "g-restaurer";
        restaurer.textContent = "↩";
        restaurer.title = "Annuler les changements de ce fichier";
        restaurer.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`Annuler les changements de ${f.chemin} ?`)) return;
          const r = await fetch("/api/git/restaurer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ws: wsActuel, chemin: f.chemin }),
          });
          const d = await r.json();
          toast(d.ok ? "↩ Fichier restauré" : "⚠️ " + d.erreur);
          chargerGit();
        };
        ligne.appendChild(restaurer);
      }
      ligne.onclick = async () => {
        const r = await fetch("/api/git/diff?ws=" + encodeURIComponent(wsActuel) +
                              "&chemin=" + encodeURIComponent(f.chemin));
        const d = await r.json();
        diffDiv.innerHTML = "";
        if (d.diff) diffDiv.appendChild(rendreDiff(d.diff));
        else diffDiv.innerHTML = '<div class="g-propre">(pas de diff — fichier nouveau ?)</div>';
      };
      fichiersDiv.appendChild(ligne);
    });
    const r = await fetch("/api/git/diff?ws=" + encodeURIComponent(wsActuel));
    const d = await r.json();
    if (d.diff) diffDiv.appendChild(rendreDiff(d.diff));
  } catch (e) {
    brancheSpan.textContent = "erreur";
  }
}

document.getElementById("git-btn").addEventListener("click", () => {
  modalGit.classList.add("ouvert");
  chargerGit();
});
document.getElementById("g-rafraichir").addEventListener("click", chargerGit);
document.getElementById("g-init").addEventListener("click", async () => {
  const r = await fetch("/api/git/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ws: wsActuel }),
  });
  const d = await r.json();
  toast(d.ok ? "✓ Dépôt initialisé" : "⚠️ " + d.erreur);
  chargerGit();
});
document.getElementById("g-commit").addEventListener("click", async () => {
  const message = document.getElementById("g-message").value.trim();
  if (!message) { toast("Écris un message de commit"); return; }
  const r = await fetch("/api/git/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ws: wsActuel, message }),
  });
  const d = await r.json();
  if (d.ok) {
    toast("✓ Commit créé");
    document.getElementById("g-message").value = "";
    chargerGit();
  } else {
    toast("⚠️ " + (d.erreur || "commit impossible"));
  }
});

/* ===== Démarrage ===== */

async function demarrer() {
  if (!(await assurerCle())) {
    // Ni clé mémorisée, ni accès local : c'est un appareil distant sans le lien complet.
    chatDiv.innerHTML =
      '<div class="vide"><h2>🔒 Accès protégé</h2>' +
      '<p>Pour ouvrir l\'agent sur cet appareil, utilise le lien complet ' +
      '<b>http://IP:5000/?cle=…</b> affiché sur le PC ' +
      '(bouton <b>📱 Téléphone</b> dans l\'en-tête).</p></div>';
    return;
  }
  await chargerModeles();
  try {
    const resConfig = await fetch("/api/config");
    const config = await resConfig.json();
    wsActuel = config.workspace;
    majDossierPartout();
    if (selectModele.querySelector(`option[value="${config.modele}"]`)) {
      selectModele.value = config.modele;
    }
  } catch (e) { /* ignore */ }
  try {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    if (data.conversations.length) {
      await ouvrirConversation(data.conversations[0].id);
    } else {
      chargerConversations();
    }
  } catch (e) { /* accueil par défaut */ }
}

/* Sidebar mobile */
const asideConv = document.getElementById("conversations");
const voileConv = document.getElementById("voile-conv");
function basculerConv() {
  asideConv.classList.toggle("ouvert");
  voileConv.classList.toggle("ouvert", asideConv.classList.contains("ouvert"));
}
function fermerConvMobile() {
  asideConv.classList.remove("ouvert");
  voileConv.classList.remove("ouvert");
}

/* ===== Saisie ===== */

function autoTaille() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

input.addEventListener("input", autoTaille);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    envoyer();
  }
});
boutonEnvoyer.addEventListener("click", () => (enCours ? arreter() : envoyer()));
document.getElementById("nouvelle").addEventListener("click", nouvelleConversation);
document.getElementById("toggle-conv").addEventListener("click", basculerConv);
voileConv.addEventListener("click", fermerConvMobile);

document.addEventListener("click", (e) => {
  const sugg = e.target.closest(".sugg");
  if (sugg) {
    input.value = sugg.textContent.replace(/^\S+\s/, "");
    envoyer();
    return;
  }
  if (e.target.closest(".ws-changer")) ouvrirModalDossier();
});

/* ===== Explorateur de fichiers (navigateur de disque) ===== */
const explorateur = document.getElementById("explorateur");
const voileExp = document.getElementById("voile-exp");
const arbre = document.getElementById("arbre");
const expChemin = document.getElementById("exp-chemin");
const expParent = document.getElementById("exp-parent");
const expTravailler = document.getElementById("exp-travailler");
const visionneuse = document.getElementById("visionneuse");
let cheminExplore = null;   // chemin absolu courant ; null = jamais ouvert ; "" = liste des lecteurs
let parentExplore = null;   // chemin du parent (null = on est déjà à la racine)

function iconeFichier(nom) {
  const ext = nom.split(".").pop().toLowerCase();
  const m = { py: "🐍", js: "📜", ts: "📜", html: "🌐", css: "🎨",
    json: "🔧", md: "📝", txt: "📄", env: "🔑", sh: "⚡", bat: "⚡",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️" };
  return m[ext] || "📄";
}

function sansSlash(p) { return (p || "").replace(/[\\/]+$/, ""); }

async function chargerExplorateur(chemin) {
  arbre.innerHTML = '<div class="ligne muet">chargement…</div>';
  try {
    const res = await fetch("/api/parcourir?chemin=" + encodeURIComponent(chemin || ""));
    const data = await res.json();
    if (data.erreur) { arbre.innerHTML = '<div class="ligne muet">⚠️ ' + data.erreur + '</div>'; return; }
    cheminExplore = data.chemin;
    parentExplore = data.parent === null ? null : (data.parent || "");
    expChemin.textContent = data.chemin || "💻 Poste de travail";
    expChemin.title = data.chemin || "Lecteurs du PC";
    expParent.disabled = (parentExplore === null);
    expTravailler.disabled = !data.chemin;
    arbre.innerHTML = "";
    if (!data.entrees.length) { arbre.innerHTML = '<div class="ligne muet">(dossier vide)</div>'; return; }
    data.entrees.forEach((e) => arbre.appendChild(ligneExplorateur(e)));
  } catch (e) {
    arbre.innerHTML = '<div class="ligne muet">Erreur de chargement</div>';
  }
}

function ligneExplorateur(e) {
  const ligne = document.createElement("div");
  ligne.className = "ligne " + e.type;
  const estWs = e.type === "dossier" && wsActuel &&
    sansSlash(e.chemin).toLowerCase() === sansSlash(wsActuel).toLowerCase();
  const ico = document.createElement("span");
  ico.className = "ico";
  ico.textContent = e.type === "dossier" ? (estWs ? "📌" : "📁") : iconeFichier(e.nom);
  const nom = document.createElement("span");
  nom.className = "nom";
  nom.textContent = e.nom;
  ligne.appendChild(ico);
  ligne.appendChild(nom);
  if (estWs) {
    const badge = document.createElement("span");
    badge.className = "exp-badge";
    badge.textContent = "travail";
    ligne.appendChild(badge);
  }
  if (e.type === "dossier") ligne.onclick = () => chargerExplorateur(e.chemin);
  else ligne.onclick = () => apercuEntree(e.chemin, e.nom);
  return ligne;
}

// Un fichier situé dans le dossier de travail est éditable ; ailleurs, lecture seule.
function apercuEntree(abs, nom) {
  const racine = sansSlash(wsActuel).toLowerCase();
  if (racine && abs.toLowerCase().startsWith(racine + "\\")) {
    ouvrirFichier(abs.slice(sansSlash(wsActuel).length + 1).replace(/\\/g, "/"));
  } else {
    ouvrirApercu(abs, nom);
  }
}

function basculerExplorateur() {
  const ouvert = explorateur.classList.toggle("ouvert");
  voileExp.classList.toggle("ouvert", ouvert);
  if (ouvert) chargerExplorateur(cheminExplore == null ? (wsActuel || "") : cheminExplore);
}

function rafraichirExplorateur() {
  chargerExplorateur(cheminExplore == null ? (wsActuel || "") : cheminExplore);
}

function rafraichirExplorateurSiOuvert() {
  if (explorateur.classList.contains("ouvert")) rafraichirExplorateur();
}

expParent.addEventListener("click", () => {
  if (parentExplore !== null) chargerExplorateur(parentExplore);
});
expTravailler.addEventListener("click", async () => {
  if (!cheminExplore) return;
  wsActuel = cheminExplore;
  majDossierPartout();
  await patchConv({ workspace: wsActuel });
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: wsActuel }),
  });
  toast("📌 Dossier de travail : " + basename(wsActuel));
  chargerExplorateur(cheminExplore);  // re-render pour afficher le badge « travail »
});

/* ===== Visionneuse / éditeur ===== */
let fichierOuvert = null;
let contenuOuvert = "";
let lectureSeule = false;   // vrai pour un fichier hors du dossier de travail
const btnModifier = visionneuse.querySelector(".v-modifier");
const btnEnregistrer = visionneuse.querySelector(".v-enregistrer");
const btnTelecharger = visionneuse.querySelector(".v-telecharger");

function afficherLecture() {
  const corps = visionneuse.querySelector(".v-corps");
  corps.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "bloc-code";
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-" + devinerLangue(fichierOuvert);
  code.textContent = contenuOuvert;
  pre.appendChild(code);
  wrap.appendChild(pre);
  corps.appendChild(wrap);
  hljs.highlightElement(code);
  btnModifier.style.display = lectureSeule ? "none" : "";
  btnEnregistrer.style.display = "none";
}

function afficherEdition() {
  const corps = visionneuse.querySelector(".v-corps");
  corps.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.className = "v-editeur";
  ta.value = contenuOuvert;
  ta.spellcheck = false;
  corps.appendChild(ta);
  ta.focus();
  btnModifier.style.display = "none";
  btnEnregistrer.style.display = "";
}

async function enregistrerFichier() {
  const ta = visionneuse.querySelector(".v-editeur");
  if (!ta || fichierOuvert === null) return;
  try {
    const res = await fetch("/api/fichier/sauver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chemin: fichierOuvert, contenu: ta.value, ws: wsActuel }),
    });
    const data = await res.json();
    if (data.erreur) { toast("⚠️ " + data.erreur); return; }
    contenuOuvert = ta.value;
    toast("Enregistré ✓");
    afficherLecture();
  } catch (e) {
    toast("⚠️ Erreur de connexion");
  }
}

async function ouvrirFichier(rel) {
  const titre = visionneuse.querySelector(".v-titre");
  const corps = visionneuse.querySelector(".v-corps");
  titre.textContent = rel;
  corps.innerHTML = '<div style="color:var(--muted);padding:8px">chargement…</div>';
  lectureSeule = false;
  btnModifier.style.display = "none";
  btnEnregistrer.style.display = "none";
  btnTelecharger.style.display = "";
  visionneuse.classList.add("ouvert");
  try {
    const res = await fetch("/api/fichier?chemin=" + encodeURIComponent(rel) +
                            "&ws=" + encodeURIComponent(wsActuel));
    const data = await res.json();
    if (data.erreur) {
      corps.innerHTML = '<div style="color:#f87171;padding:8px">' + data.erreur + '</div>';
      return;
    }
    fichierOuvert = rel;
    contenuOuvert = data.contenu;
    afficherLecture();
    visionneuse.querySelector(".v-copier").onclick = () => {
      navigator.clipboard.writeText(contenuOuvert);
      toast("Copié ✓");
    };
  } catch (e) {
    corps.innerHTML = '<div style="color:#f87171;padding:8px">Erreur de chargement</div>';
  }
}

// Aperçu lecture seule d'un fichier hors du dossier de travail (chemin absolu).
async function ouvrirApercu(abs, nom) {
  const titre = visionneuse.querySelector(".v-titre");
  const corps = visionneuse.querySelector(".v-corps");
  titre.textContent = "🔒 " + nom;
  corps.innerHTML = '<div style="color:var(--muted);padding:8px">chargement…</div>';
  lectureSeule = true;
  fichierOuvert = null;   // hors workspace : ni édition ni téléchargement
  btnModifier.style.display = "none";
  btnEnregistrer.style.display = "none";
  btnTelecharger.style.display = "none";
  visionneuse.classList.add("ouvert");
  try {
    const res = await fetch("/api/apercu?chemin=" + encodeURIComponent(abs));
    const data = await res.json();
    if (data.erreur) {
      corps.innerHTML = '<div style="color:#f87171;padding:8px">' + data.erreur + '</div>';
      return;
    }
    contenuOuvert = data.contenu;
    afficherLecture();
    visionneuse.querySelector(".v-copier").onclick = () => {
      navigator.clipboard.writeText(contenuOuvert);
      toast("Copié ✓");
    };
  } catch (e) {
    corps.innerHTML = '<div style="color:#f87171;padding:8px">Erreur de chargement</div>';
  }
}

btnModifier.addEventListener("click", afficherEdition);
btnEnregistrer.addEventListener("click", enregistrerFichier);
visionneuse.querySelector(".v-telecharger").addEventListener("click", () => {
  if (!fichierOuvert) return;
  const a = document.createElement("a");
  a.href = "/api/telecharger?chemin=" + encodeURIComponent(fichierOuvert) +
           "&ws=" + encodeURIComponent(wsActuel);
  document.body.appendChild(a);
  a.click();
  a.remove();
});
document.getElementById("toggle-fichiers").addEventListener("click", basculerExplorateur);
document.getElementById("rafraichir").addEventListener("click", rafraichirExplorateur);
voileExp.addEventListener("click", basculerExplorateur);

/* ===== Accès téléphone ===== */
const modalPhone = document.getElementById("modal-phone");
async function ouvrirPhone() {
  const corps = document.getElementById("phone-corps");
  corps.innerHTML = '<p class="phone-msg muet">chargement…</p>';
  modalPhone.classList.add("ouvert");
  let data;
  try {
    data = await (await fetch("/api/reseau")).json();
  } catch (e) { corps.innerHTML = '<p class="phone-msg">Erreur réseau.</p>'; return; }
  if (!data.ip) {
    corps.innerHTML = '<p class="phone-msg">Impossible de détecter l\'adresse réseau du PC. ' +
      'Vérifie que le Wi-Fi est activé.</p>';
    return;
  }
  if (!data.ouvert_reseau) {
    corps.innerHTML =
      '<p class="phone-msg">Le serveur n\'écoute pas encore sur le réseau local.</p>' +
      '<p class="phone-aide">Ferme l\'agent (⏻), puis relance-le avec le raccourci ' +
      '<b>« Agent de Code (Wi-Fi) »</b> ou le fichier <code>lancer-wifi.bat</code> : ' +
      'il activera l\'accès téléphone. Reviens ensuite ici pour le QR code.</p>';
    return;
  }
  corps.innerHTML =
    '<p class="phone-msg">Sur ton téléphone (<b>même Wi-Fi</b>), scanne ce QR code ' +
    'ou tape l\'adresse :</p>' +
    '<div id="phone-qr" class="phone-qr"></div>' +
    '<div class="phone-url"><code id="phone-url-txt"></code>' +
    '<button id="phone-copier" title="Copier le lien">Copier</button></div>' +
    '<p class="phone-aide">Puis, dans le menu du navigateur, choisis ' +
    '« Ajouter à l\'écran d\'accueil » pour l\'installer comme une vraie appli. ' +
    'Le lien contient ta clé d\'accès — garde-le pour toi.</p>';
  document.getElementById("phone-url-txt").textContent = data.url;
  document.getElementById("phone-copier").onclick = () => {
    navigator.clipboard.writeText(data.url);
    toast("Lien copié ✓");
  };
  try {
    const r = await fetch("/api/qr?url=" + encodeURIComponent(data.url));
    const qr = document.getElementById("phone-qr");
    if (r.ok) qr.innerHTML = await r.text();
    else qr.style.display = "none";
  } catch (e) {
    document.getElementById("phone-qr").style.display = "none";
  }
}
document.getElementById("btn-phone").addEventListener("click", ouvrirPhone);

/* ===== Arrêt du serveur ===== */
document.getElementById("btn-quitter").addEventListener("click", async () => {
  if (!confirm("Arrêter le serveur de l'agent ?")) return;
  try { await fetch("/api/quitter", { method: "POST" }); } catch (e) { /* le serveur coupe */ }
  document.body.innerHTML =
    '<div class="ecran-off"><div><div class="ecran-off-ico">⏻</div>' +
    '<h2>Serveur arrêté</h2><p>Tu peux fermer cet onglet. ' +
    'Relance l\'agent avec l\'icône du bureau.</p></div></div>';
});

/* Fermeture générique des modales (croix, clic sur le fond, Échap) */
document.querySelectorAll(".modal").forEach((modal) => {
  modal.querySelectorAll(".m-fermer").forEach((b) =>
    b.addEventListener("click", () => modal.classList.remove("ouvert")));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("ouvert");
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".modal.ouvert")
    .forEach((m) => m.classList.remove("ouvert"));
});

/* ===== Upload / téléchargement de fichiers ===== */
const depotVoile = document.getElementById("depot-voile");
const champFichier = document.getElementById("fichier-input");
let dragCompteur = 0;

function ajouterPastille(nom) {
  const cont = document.getElementById("pieces-jointes");
  const el = document.createElement("span");
  el.className = "pj";
  el.innerHTML = '<span>📎</span><span class="pj-nom"></span>' +
    '<span class="pj-etat">…</span><button class="pj-x" title="Retirer">✕</button>';
  el.querySelector(".pj-nom").textContent = nom;
  el.querySelector(".pj-x").onclick = () => {
    if (el.dataset.chemin) fichiersJoints = fichiersJoints.filter((c) => c !== el.dataset.chemin);
    el.remove();
  };
  cont.appendChild(el);
  return { el, etat: el.querySelector(".pj-etat") };
}

async function televerser(fichiers) {
  if (!wsActuel) { toast("Choisis d'abord un dossier de travail"); return; }
  for (const f of fichiers) {
    const p = ajouterPastille(f.name);
    const form = new FormData();
    form.append("fichier", f);
    form.append("ws", wsActuel);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (data.erreur) { p.el.remove(); toast("⚠️ " + data.erreur); continue; }
      fichiersJoints.push(data.chemin);
      p.el.dataset.chemin = data.chemin;
      p.etat.textContent = "✓";
      rafraichirExplorateurSiOuvert();  // le fichier apparaît dans l'explorateur
    } catch (e) {
      p.el.remove();
      toast("⚠️ Téléversement échoué");
    }
  }
}

document.getElementById("joindre").addEventListener("click", () => {
  if (!wsActuel) { toast("Choisis d'abord un dossier de travail"); return; }
  champFichier.click();
});
champFichier.addEventListener("change", (e) => {
  televerser(e.target.files);
  e.target.value = "";  // autorise le re-téléversement du même fichier
});

// Glisser-déposer sur toute la fenêtre.
window.addEventListener("dragenter", (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
    dragCompteur++;
    depotVoile.classList.add("actif");
  }
});
window.addEventListener("dragover", (e) => { if (depotVoile.classList.contains("actif")) e.preventDefault(); });
window.addEventListener("dragleave", () => {
  dragCompteur = Math.max(0, dragCompteur - 1);
  if (!dragCompteur) depotVoile.classList.remove("actif");
});
window.addEventListener("drop", (e) => {
  dragCompteur = 0;
  depotVoile.classList.remove("actif");
  if (e.dataTransfer && e.dataTransfer.files.length) {
    e.preventDefault();
    televerser(e.dataTransfer.files);
  }
});

demarrer();

/* ===== PWA : enregistrement du service worker ===== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) =>
      console.warn("Service worker non enregistré :", e)
    );
  });
}
