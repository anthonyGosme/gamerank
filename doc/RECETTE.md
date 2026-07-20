# Recette manuelle — état au 20 juillet 2026

Couvre les US terminées : US-1.1, US-1.2 (compte), US-2.1 (déclarer un jeu),
US-6.0 (hub), US-4.4 (ingestion ClickHouse), US-8.0 (admin).

## Tests automatisés (le plus rapide)

Les parcours critiques (auth complète, ingestion et ses rejets) sont
couverts par la suite de tests — conteneurs démarrés requis :

```bash
npm run db:up && npm run migrate
npm test        # 11 tests : auth (4) + ingestion (7)
```

C'est la recette officielle de l'US-4.4 ; les scénarios manuels ci-dessous
restent utiles pour voir le produit.

## Ce qui existe (résumé)

```text
apps/api            API Fastify + pages HTML minimales
  migrations/       001 auth · 002 jeux · 003 description+vignette obligatoires
docker-compose.yml  postgres (données) · clickhouse (événements) · mailpit (emails dev)
```

* **Auth** : magic link par email (aucun mot de passe). En dev, les emails
  ne partent pas vraiment : ils sont capturés par **Mailpit**.
* **Jeux** : déclaration avec nom + URL + description + vignette téléversée ;
  clé SDK générée ; statut `Awaiting jury`.
* **Ingestion** : `POST /api/ingest` reçoit les événements (futur SDK), les
  valide (clé + domaine d'origine) et les stocke dans ClickHouse (purge auto
  à 3 jours).

## Démarrage

```bash
cd ~/repo/gamerank
npm install
cp .env.example .env      # si pas déjà fait
npm run db:up             # postgres + clickhouse + mailpit
npm run migrate
npm run dev               # API sur http://localhost:3000
```

Deux onglets utiles : le site http://localhost:3000 et Mailpit
http://localhost:8025 (boîte mail de dev).

## Scénario 1 — Inscription / connexion (US-1.1, US-1.2)

1. Ouvrir http://localhost:3000 → page **Login**.
2. Saisir un email, cliquer *Send me a login link* → message « a login link
   is on its way ».
3. Ouvrir Mailpit → un mail « Your GameRank login link » → cliquer le lien.
4. **Attendu** : redirection vers le dashboard, email affiché en haut.
5. Recliquer le même lien (dans Mailpit) dans un onglet privé →
   **attendu** : retour login avec « Invalid or expired link » (usage unique).
6. *Log out* → retour login ; retour manuel sur `/dashboard` → renvoyé au
   login (session révoquée).
7. Redemander un lien avec le même email → reconnexion sur le même compte
   (pas de doublon).

Cas limites : email invalide → « Invalid email address » ; deux demandes en
moins de 60 s → un seul mail (throttle).

## Scénario 2 — Déclarer un jeu (US-2.1)

1. Connecté, cliquer *+ Add a game*.
2. Remplir nom, URL (ex. `https://monjeu.example.com`), description,
   choisir une image (PNG/JPEG/WebP/GIF < 2 Mo). Tous obligatoires.
3. **Attendu** : page du jeu avec vignette, badge `Awaiting jury`, clé SDK
   `gr_…`, et la mention du domaine autorisé.
4. Re-déclarer la même URL avec le même compte → **attendu** :
   « you already registered a game at this URL » (un autre compte, lui,
   peut déclarer la même URL).
   4bis. Sur la page du jeu, bouton **Delete this game** (confirmation
   demandée) → retour au dashboard, le jeu a disparu. Un compte ne peut
   supprimer que ses propres jeux.
5. Au 6e jeu du compte → **attendu** : « limit of 5 games per account
   reached ».

## Scénario 3 — Hub (US-6.0)

1. Retour *← My games* : le jeu apparaît avec sa miniature, son domaine et
   son statut.
2. État vide (compte neuf) : message d'accueil avec lien vers la
   déclaration.

## Scénario 4 — Ingestion d'événements (US-4.4)

Récupérer la clé SDK du jeu (affichée sur sa page), puis simuler ce que le
futur SDK enverra :

```bash
KEY=gr_…   # la clé du jeu
ORIGIN=https://monjeu.example.com   # le domaine déclaré

curl -i -X POST http://localhost:3000/api/ingest \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
  -d "{\"key\":\"$KEY\",\"sdkVersion\":\"0.1.0\",\"events\":[
    {\"type\":\"session_start\",\"visitorId\":\"vis-1\",\"sessionId\":\"ses-1\"},
    {\"type\":\"heartbeat\",\"visitorId\":\"vis-1\",\"sessionId\":\"ses-1\",\"activeMs\":15000}]}"
```

**Attendu** : `204 No Content`. Vérifier le stockage :

```bash
# Les événements dans ClickHouse :
curl -s -u gamerank:gamerank "http://localhost:8123/?database=gamerank" \
  -d "SELECT event_type, visitor_id, active_ms, ts FROM events ORDER BY ts FORMAT PrettyCompactNoEscapes"

# Le jeu a bien reçu ses événements (base de l'indicateur US-2.2) :
docker compose exec -T postgres psql -U gamerank \
  -c "SELECT name, last_event_at FROM games;"
```

Rejets silencieux (toujours `204`, mais **rien ne doit apparaître** dans
ClickHouse) :

* mauvaise origine : remplacer `Origin:` par un autre domaine ;
* clé inconnue : `"key":"gr_fausse"` ;
* type inconnu (`"type":"hack"`) : filtré ;
* `activeMs` énorme : plafonné à 120 000 ms.

## Scénario 5 — SDK sur le jeu de démo (US-4.1, US-4.2, US-2.2)

1. Builder le SDK : `npm run build:sdk` (sinon `/sdk.js` répond 404).
2. Déclarer un jeu avec l'URL `http://localhost:4321/` (localhost est
   accepté) → ouvrir sa page, copier la clé `gr_…`.
3. Lancer le jeu de démo : `GAMERANK_KEY=gr_… npm run dev -w apps/demo-game`
   puis ouvrir `http://localhost:4321/`. La page servie contient le snippet
   littéral (`<script src=…/sdk.js data-key=… async>`) — exactement ce
   qu'un vrai site colle ; la clé est un attribut du script, jamais un
   paramètre d'URL. Sans variable d'environnement, la clé de démo
   `gr_demo_catchsquare01` est utilisée.
4. Jouer quelques secondes (cliquer les cases oranges).
5. **Attendu** sur la page du jeu (gamerank) : « Events received ✓ » avec
   l'heure du dernier événement (rafraîchi toutes les 10 s).
   5bis. **Vérification d'intégration** : tant que non vérifiée, message
   rouge « ⚠ Verify your integration » + bouton « Verify code ».
   - Jeu **local** (case « local address » cochée à la déclaration ;
     obligatoire pour une URL localhost/IP) : la vérification passe dès que
     des événements ont été reçus.
   - Jeu **NDD internet** : le backend télécharge la page déclarée et
     cherche la balise (`sdk.js` + clé) ; message d'erreur explicite si la
     page est injoignable ou la balise absente.
   Une fois vérifié : « Integration verified ✓ » en vert avec la date.
6. **Attendu** sur `/admin` : `load`, `session_start`, puis des `heartbeat`
   à cadence exponentielle (5 s, 15 s, 45 s, 135 s max) avec `activeMs`.
7. Laisser l'onglet du jeu **caché ou sans input > 60 s** → `activeMs`
   n'augmente plus (le temps inactif ne compte pas).

## Scénario 6 — Badge et vote (US-4.3)

1. Sur la page du jeu (gamerank), section *Integration* : un seul snippet
   (mesure + badge), aperçu du badge **avec flèches**, et le **color
   picker** — choisir une couleur claire : le texte passe automatiquement
   en sombre (contraste calculé côté serveur). Le jeu de démo l'intègre déjà.
2. Ouvrir le jeu de démo : le badge « GAMERANK / NEW » (180×40, couleur du
   jeu) est sous la grille — c'est une image + lien, il s'affiche même sans
   JavaScript, sans flèches tant qu'on ne joue pas.
3. Jouer ≥ 5 s → les flèches ▼ ▲ apparaissent en fondu.
4. Cliquer ▲ avant 60 s de jeu total → bulle « Keep playing before
   voting », rien en base.
5. Rejouer jusqu'à 60 s (ou revenir plus tard) puis voter → la flèche
   passe orange, et la ligne apparaît :
   `docker compose exec -T postgres psql -U gamerank -c "SELECT * FROM votes;"`
6. Revoter ▼ → la même ligne change de valeur (un vote par visiteur).
7. Le centre du badge reste un lien vers la fiche publique `/g/<id>`.

## Scénario 7 — Admin : observer l'ingestion (US-8.0)

1. Vérifier que ton email est dans `ADMIN_EMAILS` du `.env` (redémarrer
   `npm run dev` après modification).
2. Connecté avec cet email, ouvrir http://localhost:3000/admin.
3. **Attendu** : tableau de tous les jeux (développeur, domaine, statut,
   dernier événement, événements / visiteurs / minutes actives 24 h) et
   les 30 derniers événements bruts.
4. Envoyer un batch (scénario 4) puis recharger → les compteurs bougent.
5. Avec un compte non listé dans `ADMIN_EMAILS` → renvoyé au dashboard.

## Pas encore développé (ne pas recetter)

Widget de vote (US-4.3), jury (épic 3), site public (épic 5), métriques et
scores (US-6.1/6.2, épic 7), file de revue et masquage admin (US-8.1/8.2).

## Réinitialiser l'environnement

```bash
npm run db:down             # stoppe les conteneurs, garde les données
docker compose down -v      # ⚠ efface tout (bases) → refaire npm run migrate
```
