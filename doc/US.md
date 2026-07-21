# GameRank — User Stories (MVP)

> Découle du [CDC-classement-v2.md](CDC-classement-v2.md). Les références §x
> renvoient au CDC.
>
> Décisions produit cadrées :
> * les jeux se jouent **sur le site du développeur** (lien sortant, pas
>   d'iframe) — le SDK y tourne, le dev garde son trafic ;
> * le vote joueur se fait via un **widget affiché par le SDK dans le jeu**,
>   débloqué après le temps de jeu minimal ;
> * authentification développeur par **magic link email** ;
> * administration **minimale** (revue des marquages, pas de validation
>   manuelle avant publication).

Acteurs :

```text
Visiteur      : joueur anonyme sur le site public ou sur un jeu (UUID §3)
Développeur   : compte enregistré, propriétaire d'un ou plusieurs jeux
Juré          : développeur en train d'évaluer les 5 jeux imposés (§7.4)
Admin         : opérateur du site
Système       : jobs périodiques (agrégation, scoring, purge)
```

---

## Épic 1 — Compte développeur

### US-1.1 Inscription par magic link — ✅ fait
En tant que développeur, je veux créer un compte avec mon seul email afin de
m'inscrire sans gérer de mot de passe.

* je saisis mon email, je reçois un lien de connexion valable 15 min ;
* le lien me connecte et crée le compte à la première utilisation ;
* aucun mot de passe n'est stocké ; le lien est à usage unique ;
* l'IP et l'ASN d'inscription sont enregistrés (signaux §4 appliqués au
  futur poids de juré).

### US-1.2 Reconnexion — ✅ fait
En tant que développeur, je veux me reconnecter par magic link afin de
retrouver mon dashboard et mes jeux.

* session persistante (cookie httpOnly) ; déconnexion possible.

---

## Épic 2 — Enregistrement d'un jeu

### US-2.1 Déclarer un jeu — ✅ fait
En tant que développeur, je veux enregistrer mon jeu (nom, URL, description,
vignette) afin qu'il entre dans le classement.

* nom, URL, description, **description courte** (≤ 160 caractères, pour
  les cartes des pages de classement et la diversité SEO), **catégorie**
  (une seule, liste fermée) et vignette sont tous obligatoires ;
* la vignette est téléversée (PNG/JPEG/WebP/GIF, taille max configurable)
  et hébergée par GameRank — pas d'URL d'image externe ;
* l'URL du jeu est **unique globalement** : une URL = un seul jeu, premier
  arrivé premier servi (interdit les fiches en double et la « revendication »
  du jeu d'un autre) ;
* une **clé SDK** est générée, liée au jeu et au domaine déclaré ;
* le jeu est créé en statut `en attente du jury` : il n'apparaît pas encore
  dans le classement (voir US-3.x) ;
* limite configurable de jeux par compte (anti-sybil).

### US-2.2 Installer le SDK — ✅ fait
En tant que développeur, je veux un snippet d'intégration copiable afin
d'installer le SDK en une balise.

* le snippet contient la clé SDK ;
* la page du jeu affiche l'état de réception (`aucun événement reçu` /
  `événements reçus ✓`) pour valider l'installation ;
* les événements dont l'origine ne correspond pas au domaine déclaré sont
  rejetés ;
* **[v2]** vérification d'intégration : message rouge « Verify your
  integration » + bouton « Verify code » tant que non vérifiée ;
  jeu **local** (localhost/IP, case cochée à la déclaration) → vérifié par
  la réception d'événements SDK ; **NDD internet** → le backend télécharge
  la page et vérifie la présence de la balise (sdk.js + clé).

### US-2.3 Statut de publication — ✅ fait
En tant que développeur, je veux voir le statut de mon jeu
(`en attente du jury` → `en évaluation` → `classé`) afin de savoir où j'en
suis.

* `en évaluation` : le devoir de jury du dev est accompli, le jeu est
  visible dans la zone exploration avec badges `Nouveau` / `Score
  provisoire` (§10) ;
* `classé` : le jeu a reçu ses 5 présentations au jury (§7.4) **ou** 14
  jours se sont écoulés (garde-fou si les inscriptions ralentissent) ; il
  entre dans le classement officiel.

### US-2.5 Supprimer un jeu — ✅ fait
En tant que développeur, je veux supprimer un de mes jeux afin de retirer
du classement un site que je ne maintiens plus.

* bouton « Delete this game » sur la page du jeu, avec confirmation ;
* seul le propriétaire peut supprimer (si deux comptes ont déclaré le même
  site, chacun ne supprime que le sien) ;
* la suppression retire le jeu, ses votes et sa vignette ; les événements
  ClickHouse expirent d'eux-mêmes (TTL).

### US-2.4 Parcours de première connexion — ✅ fait
En tant que développeur nouvellement inscrit, je veux être guidé pas à pas
afin de terminer mon inscription sans me perdre.

* à la première connexion, le dashboard affiche les étapes dans l'ordre :
  `1. déclarer mon jeu → 2. installer le SDK → 3. juger 5 jeux` avec l'état
  de chacune ;
* chaque étape non terminée pointe vers l'écran correspondant ;
* le bandeau disparaît une fois les trois étapes accomplies.

---

## Épic 3 — Jury des pairs (devoir d'inscription)

### US-3.1 Recevoir ma liste de jury — ✅ fait
En tant que juré, je veux recevoir la liste des 5 derniers jeux inscrits
afin de les évaluer.

* les 5 jeux sont les plus récents, mes propres jeux exclus (§7.4) ;
* **bootstrap** : s'il existe moins de 5 jeux éligibles, je juge tous les
  jeux existants et j'élis 40 % arrondi au supérieur (min 1) ; s'il en
  existe moins de 2, l'étape est sautée ;
* la liste est figée à l'inscription (elle ne change pas si d'autres jeux
  arrivent pendant mon évaluation).

### US-3.2 Jouer aux jeux à juger — ✅ fait (option B : chronomètre)
En tant que juré, je veux lancer chaque jeu depuis ma page de jury afin que
mon temps de jeu y soit reconnu.

* **[décision]** vérification par **chronomètre côté page de jury** (option
  B), pas par token SDK cross-origin : cliquer « Play » ouvre le jeu et
  démarre un minuteur ; l'élection se débloque après le temps minimal
  (`JURY_MIN_PLAY_MS`, 20 s par défaut) ;
* le temps est reporté au serveur (`/api/jury/played`) ;
* durcissement possible en v2 vers la liaison SDK (`?gr_jury=…`).

### US-3.3 Élire les 2 meilleurs — ✅ fait
En tant que juré, je veux élire les 2 meilleurs des 5 jeux afin de terminer
mon inscription.

* l'élection n'est possible qu'une fois le temps minimal atteint sur
  **chacun** des 5 jeux ;
* exactement 2 élus, choix définitif ;
* à la validation : mes 2 élections et 5 présentations sont enregistrées
  avec mon poids de juré courant (§7.4), et mon jeu passe en `en évaluation`.

### US-3.4 Score P et poids de juré (Système) — ✅ MVP (poids 1,0)
En tant que système, je veux calculer P et pondérer les jurés.

* **P sur 7** (CDC §7.4) implémenté : `min(5, élections reçues) + consensus
  (0-2)` / 7 × 100 ; consensus = les jeux élus par le propriétaire qui sont
  aussi des choix de consensus (élus par ≥ 50 % de leurs jurés) ;
* pas de Wilson pour P (échantillon fixe de 5) ; un jeu sans activité jury
  garde le défaut 2/7 ;
* **[MVP]** poids de juré = 1,0 pour tous ; les pondérations anti-abus
  (réseau §4, confiance du propre jeu) et le marquage rafale/sous-réseau
  sont reportés en v2.

---

## Épic 4 — SDK & mesure

### US-4.1 Identifiant visiteur — ✅ fait
En tant que système, je veux identifier chaque visiteur par un UUID
localStorage par jeu afin de compter les uniques et la fidélisation sans
fingerprinting (§3).

### US-4.2 Mesure du temps actif — ✅ fait
En tant que système, je veux ne compter que le temps réellement joué afin
que les métriques soient honnêtes (§2).

* heartbeats à cadence exponentielle : 5 s → 15 s → 45 s → 135 s (plafond,
  et plafond serveur à 150 s par événement) ; la progression repart à 5 s à
  chaque nouvelle session ;
* comptage seulement si page visible + input < 60 s ; nouvelle session
  après 30 min d'inactivité ;
* événements : chargement, début de session, heartbeat, fin de session
  (sendBeacon à la fermeture) ;
* le SDK n'émet jamais d'exception vers le jeu hôte (échec silencieux) ;
* recette locale : jeu de démo `apps/demo-game` (les URL localhost sont
  acceptées à la déclaration).

### US-4.3 Widget de vote in-game — ✅ fait
En tant que visiteur, je veux voter 👍/👎 depuis le jeu afin de donner mon
avis après y avoir vraiment joué.

* le widget est un embed à taille fixe (pas de layout shift) :

```html
<div class="gamerank-badge" style="width/height fixes">
  <script src="https://gamerank…/widget.js"></script>
  <a href="https://gamerank…/g/<slug>">          ← backlink SEO, ancre neutre
    <img src="https://gamerank…/games/<id>/badge.png">  ← score rendu serveur
  </a>
</div>
```

* `badge.svg` est générée côté serveur avec le score courant (« NEW » avant
  l'épic 7), dimensions fixes, cacheable (TTL court) — le badge fonctionne
  sans JavaScript (image + lien, pas de vote) ;
* `widget.js` découpe le badge en trois zones : gauche = 👎, droite = 👍,
  centre = lien normal vers la fiche GameRank ;
* les flèches n'apparaissent qu'après 5 s de jeu actif (fondu) ; un clic
  avant l'éligibilité serveur affiche « keep playing before voting » ;
* le vote n'est actif qu'après le temps de jeu minimal (60 s actives, §7.2),
  vérifié via la session SDK ;
* un vote par visiteur (UUID) et par jeu, modifiable (le dernier remplace) ;
* contrôle d'origine : le POST de vote doit porter un en-tête
  `Origin`/`Referer` correspondant au domaine déclaré du jeu — un widget
  posé sur un autre domaine ne peut pas voter (même règle que l'ingestion
  US-4.4) ;
* SEO : ancre neutre imposée (nom du jeu ou « GameRank ») — pas d'ancre
  optimisée (politique Google sur les widget links).

### US-4.4 Ingestion des événements (Système) — ✅ fait
En tant que système, je veux stocker les événements dans ClickHouse afin de
supporter le volume (§11).

* validation de la clé SDK et de l'origine ; rejet silencieux des
  événements invalides ;
* rétention : événements bruts 2-3 j, activité quotidienne 40-45 j, purge
  automatique.

---

## Épic 5 — Site public

### US-5.1 Consulter le classement — ✅ fait
En tant que visiteur, je veux voir le classement officiel afin de découvrir
les meilleurs jeux.

* home publique `/` en trois blocs dont les titres ouvrent des **pages de
  liste dédiées et paginées** : `/top` (tous les temps), `/new` (meilleurs
  jeux récents) et `/latest` (derniers inscrits) — l'exploration des
  nouveaux jeux (§10) passe par ces sections plutôt que par des
  emplacements intercalés ;
* mise en page pleine largeur, **bandeau latéral gauche** (catégories avec
  emoji + accès Top/New/Latest), grandes vignettes carrées, score en
  pastille lisible ; les cartes du classement Top sont épurées (pas de
  texte) ;
* **coquille commune** (`layout.ts`) : le site public et les pages
  développeur (login, dashboard, fiche jeu, admin) partagent header,
  logo et styles ;
* cartes : vignette, nom, **description courte**, score (ou badge NEW),
  catégorie ;
* **pages de catégorie** `/c/<slug>` (une catégorie par jeu, choisie à la
  déclaration) avec trois tris — Top / Top new / Latest — et pagination ;
* le dernier classement valide reste affiché si un calcul échoue (§12.12) ;
* SEO : rendu serveur, sitemap.xml (fiches + catégories), robots.txt.

### US-5.2 Consulter une fiche jeu — ✅ fait
En tant que visiteur, je veux voir la fiche d'un jeu afin de décider d'y
jouer.

* URL SEO `/g/<id>/<slug>` (slug lisible, canonical, balises og) ;
* nom, vignette, descriptions, catégorie, score global, rang, sous-scores
  Popularity (G) et Quality (Q) en barres — l'axe jury affiché « coming
  soon » tant que l'épic 3 n'existe pas ;
* bouton **Play** = `/go/<id>` : le clic est **compté** (`play_clicks`)
  puis redirigé (302) vers le site du développeur.

### US-5.3 Comprendre la méthode — ✅ fait
En tant que visiteur, je veux une page publique expliquant le calcul afin de
faire confiance au classement (§12.14).

* `/methodology`, **orientée marketing** : le quoi et le pourquoi (temps
  réellement joué, la qualité peut battre le volume, votes après jeu
  vérifié, fraîcheur), **sans** formules ni seuils précis ;
* ne détaille pas les pondérations anti-abus (§7.4).

### US-5.4 Mode iframe (reporté — à re-réfléchir en toute fin)
En tant que visiteur, je veux pouvoir jouer sans quitter GameRank.

* opt-in du développeur (« Allow embedding ») : beaucoup de sites
  interdisent l'embarquement (X-Frame-Options/CSP) et certains devs
  refuseront de perdre leur trafic direct ;
* page `/play/<id>` avec iframe quand autorisé, lien sortant sinon.

---

## Épic 6 — Dashboard développeur

### US-6.0 Hub : retrouver mes jeux — ✅ fait
En tant que développeur, je veux une page d'accueil de dashboard listant mes
jeux afin d'y accéder d'un coup d'œil (référencée par US-1.2).

* liste de mes jeux : vignette, nom, statut (US-2.3), score si classé ;
* chaque jeu mène à sa page (métriques US-6.1, score US-6.2, snippet
  US-2.2) ;
* bouton « Ajouter un jeu » (US-2.1) ;
* si mon devoir de jury n'est pas accompli, un rappel y mène (US-3.x) ;
* état vide soigné à la première visite (guidé par US-2.4).

### US-6.1 Suivre mes métriques
En tant que développeur, je veux voir les métriques de mon jeu afin de
comprendre mon audience — même sans me soucier du classement.

* visiteurs uniques, temps actif, durée médiane de session, fidélisation,
  votes, jour par jour sur 30-45 j ;
* c'est le produit d'appel du SDK (§11) : il doit être utile seul.

### US-6.2 Comprendre mon score
En tant que développeur, je veux voir mes sous-scores et leur évolution afin
de savoir quoi améliorer.

* G, Q, P et le score final, avec l'historique des calculs ;
* les poids anti-triche appliqués ne sont **pas** détaillés publiquement.

---

## Épic 7 — Calcul des scores (Système)

### US-7.1 Agrégation périodique — ✅ fait
En tant que système, je veux agréger les événements en quotidiens (jeu,
visiteur, jour + sessions) afin d'alimenter le scoring (§11).

* ré-agrégation idempotente de la fenêtre des événements bruts (3 j) vers
  `daily_activity` / `daily_sessions` (ClickHouse, TTL 45 j).

### US-7.2 Poids des visiteurs — ✅ fait (ASN différé)
En tant que système, je veux appliquer le poids anti-triche à chaque
visiteur afin que la triche ne paie pas (§4).

* dégressivité par préfixe IP sur **5 niveaux**, du plus large au plus fin,
  de moins en moins sévère en remontant (exposants 0,9 / 0,85 / 0,75 /
  0,65 / 0,5 configurables) ; le niveau le plus restrictif gagne :

```text
IPv4 : /8    /16   /20   /24   /32 (adresse exacte)
IPv6 : /32   /48   /56   /64   /128
```

* IPv6 : ~40-45 % du trafic réel, donc géré nativement. Les adresses
  IPv4-mappées (`::ffff:81.2.3.4`, renvoyées par un socket dual-stack)
  sont normalisées en IPv4 avant tout groupement, et la forme compressée
  (`::`) est développée. Le **/64 IPv6 joue le rôle du /32 IPv4** : un
  foyer possède un /64 entier et les extensions de confidentialité font
  tourner les /128, donc l'adresse exacte n'est pas une identité fiable ;
* partage inter-jeux : un préfixe IP hyperactif sur N jeux ne compte pas
  N fois (part = (usage local / usage plateforme)^(1−γ), γ = 0,7) ; les
  votes sont pondérés pareil, plus n^0,5 par IP au sein d'un même jeu
  (ferme la faille « vider le localStorage et revoter ») ;
* **[reporté]** facteur ASN : nécessite la base MaxMind (clé gratuite).
  Lookup local sans appel réseau — pas de risque de lenteur — mais activé
  en v2+ ; facteur ×1,0 en attendant.

### US-7.3 Cumuls décroissants — ✅ fait
En tant que système, je veux des cumuls ×0,95/jour par métrique et par jeu
(§5) — sauf l'axe peer, à échantillon fixe (§7.4).

* implémentés en recalcul complet depuis les 45 j d'agrégats à chaque
  passe (auto-réparant, sans état) plutôt qu'en accumulateur incrémental —
  la queue au-delà de 45 j (~10 % de poids) est assumée perdue.

### US-7.4 Calcul des scores — ✅ fait
En tant que système, je veux recalculer périodiquement : corrections
(Wilson, confiance) → normalisation (50 % absolu + 50 % percentile) →
moyennes pondérées → `Score = 0,30 G + 0,55 Q + 0,15 P` (§6-§9).

* cadence **réglable en secondes** (`PIPELINE_INTERVAL_SECONDS`, 30 s en
  dev/lancement) + bouton « Recompute now » dans l'admin ; la **durée de
  chaque passe** est historisée et affichée dans l'admin pour ajuster la
  cadence si ça rame ;
* P suit le barème sur **7 points** du jury (§7.4 : 5 points d'élections
  reçues + 2 points de consensus) ; **2/7 par défaut** tant que le jury
  (épic 3) n'existe pas — valeur uniforme, donc sans effet sur l'ordre ;
* **aucun seuil d'éligibilité** : tous les jeux entrent au classement dès
  la première donnée (le shrinkage protège des petits échantillons) ;
* le score v1 (proposition A, percentiles purs) est calculé en parallèle
  et conservé en interne (§9) ;
* toutes les constantes sont en configuration, pas en dur (§13) ;
* un calcul échoué n'écrase jamais le dernier classement valide
  (`current_score` n'est mis à jour que sur run réussi) ;
* le badge affiche le score dès qu'il existe (« NEW » sinon), la page du
  jeu montre score + rang.

---

## Épic 8 — Administration

### US-8.0 Observabilité de l'ingestion — ✅ fait
En tant qu'admin, je veux une page interne montrant les jeux et les
événements reçus afin de vérifier que la mesure fonctionne (ce qu'on ne
visualise pas dérive sans qu'on le voie).

* `/admin` réservé aux emails listés dans `ADMIN_EMAILS` (404 sinon, pas
  d'énumération de la route) ;
* tableau de tous les jeux (tous comptes) : rang, score, développeur,
  domaine, statut, dernier événement, événements / visiteurs / minutes
  actives sur 24 h ;
* **20 dernières passes de scoring** avec leur durée (pour régler la
  cadence si ça rame) et bouton « Recompute now » ;
* liste des 30 derniers événements bruts (type, visiteur, session,
  activeMs, IP, version SDK) ;
* la page dégrade proprement si ClickHouse est indisponible.

### US-8.1 File de revue
En tant qu'admin, je veux voir les jeux et jurys marqués par l'anti-triche
afin de trancher à la main (§4.4).

* motif du marquage, métriques suspectes, décisions : ignorer / masquer le
  jeu / ajuster le poids d'un juré ;
* aucune sanction automatique — le marquage ne déclasse pas (§4.4).

### US-8.1bis Panneau admin sur la fiche jeu — ✅ fait
En tant qu'admin, je veux voir les infos d'un jeu et agir depuis sa page
publique.

* injecté côté client sur `/g/:id` si `/api/admin/games/:id` répond 200
  (page publique inchangée pour les visiteurs) ;
* affiche : email du développeur, statut, clics « Play », votes up/down
  et % positif ;
* boutons **Hide from site** (masque, réversible) et **Delete game**
  (supprime n'importe quel jeu, avec sa vignette et ses votes).

### US-8.2 Masquer un jeu
En tant qu'admin, je veux masquer un jeu (triche avérée, contenu
inapproprié) afin de protéger le classement.

* le jeu disparaît du site public ; ses données sont conservées ; le
  développeur en est notifié par email ; opération réversible.

---

## Hors périmètre MVP (rappel §14)

* moyenne géométrique sur Q, Thompson sampling, pondération G/Q/P
  adaptative, jurés volontaires récurrents, iframe, normalisation par
  genre, signalement par les visiteurs, validation manuelle avant
  publication.
