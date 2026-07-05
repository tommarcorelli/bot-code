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
  if (!texte || enCours) return;
  messageUtilisateur(texte);
  input.value = "";
  autoTaille();
  await requeteStream("/api/chat", { message: texte, conversation: convId });
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
  return '<div class="vide" id="accueil"><h2>' + titre + '</h2>' +
    '<p>Demande-moi de lire, écrire, chercher ou exécuter du code.</p></div>';
}

function appliquerConv(data) {
  convId = data.id;
  if (data.workspace) {
    wsActuel = data.workspace;
    wsNom.textContent = basename(wsActuel);
    arbreCharge = false;  // l'explorateur suivra le nouveau dossier
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

document.getElementById("ws-btn").addEventListener("click", () => {
  modalDossier.classList.add("ouvert");
  chargerDossiers(wsActuel || "");
});

document.getElementById("d-choisir").addEventListener("click", async () => {
  if (!dossierCourant) { toast("Choisis un dossier (pas la liste des lecteurs)"); return; }
  wsActuel = dossierCourant;
  wsNom.textContent = basename(wsActuel);
  arbreCharge = false;
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
  await chargerModeles();
  try {
    const resConfig = await fetch("/api/config");
    const config = await resConfig.json();
    wsActuel = config.workspace;
    wsNom.textContent = basename(wsActuel);
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
  }
});

/* ===== Explorateur de fichiers ===== */
const explorateur = document.getElementById("explorateur");
const voileExp = document.getElementById("voile-exp");
const arbre = document.getElementById("arbre");
const visionneuse = document.getElementById("visionneuse");
let arbreCharge = false;

function iconeFichier(nom) {
  const ext = nom.split(".").pop().toLowerCase();
  const m = { py: "🐍", js: "📜", ts: "📜", html: "🌐", css: "🎨",
    json: "🔧", md: "📝", txt: "📄", env: "🔑", sh: "⚡", bat: "⚡",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️" };
  return m[ext] || "📄";
}

async function chargerDossier(rel, conteneur) {
  conteneur.innerHTML = '<div class="ligne" style="color:var(--muted)">chargement…</div>';
  try {
    const res = await fetch("/api/arborescence?dossier=" + encodeURIComponent(rel) +
                            "&ws=" + encodeURIComponent(wsActuel));
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

/* ===== Visionneuse / éditeur ===== */
let fichierOuvert = null;
let contenuOuvert = "";
const btnModifier = visionneuse.querySelector(".v-modifier");
const btnEnregistrer = visionneuse.querySelector(".v-enregistrer");

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
  btnModifier.style.display = "";
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
  btnModifier.style.display = "none";
  btnEnregistrer.style.display = "none";
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

btnModifier.addEventListener("click", afficherEdition);
btnEnregistrer.addEventListener("click", enregistrerFichier);
document.getElementById("toggle-fichiers").addEventListener("click", basculerExplorateur);
document.getElementById("rafraichir").addEventListener("click", () => chargerDossier("", arbre));
voileExp.addEventListener("click", basculerExplorateur);

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

demarrer();

/* ===== PWA : enregistrement du service worker ===== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) =>
      console.warn("Service worker non enregistré :", e)
    );
  });
}
