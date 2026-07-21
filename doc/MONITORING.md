# Supervision & alertes — WebGameRank

Objectif : savoir **en continu** si l'envoi des emails fonctionne, repérer les
erreurs serveur, et **être prévenu sur ton téléphone (ntfy)** dès qu'un truc casse.

Trois couches complémentaires :

| # | Couche | Répond à la question | Où |
|---|--------|----------------------|-----|
| 1 | Endpoints santé dans l'app | « l'app arrive-t-elle à envoyer / joindre la DB ? » | code (`apps/api/src/health.ts`) |
| 2 | Uptime Kuma + ntfy | « quelque chose est tombé → préviens-moi » | `monitoring/` sur le VPS |
| 3 | Serveur & délivrabilité | « le VPS/Poste.io est sain, pas blacklisté ? » | VPS / checks périodiques |

---

## Couche 1 — Endpoints santé (déjà en place)

Exposés par l'API. Chacun renvoie `200` si sain, `503` sinon.

| Endpoint | Vérifie | Corps |
|----------|---------|-------|
| `GET /health` | liveness (le process répond) | `{"ok":true}` |
| `GET /health/ready` | + PostgreSQL joignable | `{"ok":true,"db":true}` |
| `GET /health/email` | connexion **+ auth SMTP** (sonde `verify()`, cache 60 s) et stats des vrais envois | voir ci-dessous |

Exemple `/health/email` :
```json
{
  "ok": true,
  "smtp": { "reachable": true },
  "sends": {
    "lastSuccessAt": "2026-07-21T09:12:03.000Z",
    "lastErrorAt": null,
    "lastError": null,
    "consecutiveFailures": 0,
    "totalSent": 42,
    "totalFailed": 1
  }
}
```
- `smtp.reachable=false` → le serveur mail/tunnel est injoignable ou l'auth échoue
  (c'est exactement le `500 plugin timeout` / `ECONNREFUSED` qu'on a vus).
- `consecutiveFailures >= 3` → bascule en `503` même si la sonde répond
  (des envois réels partent en erreur en série).

> ⚠️ `/health/email` peut contenir des messages d'erreur : à **ne pas exposer
> publiquement**. Kuma le sonde en interne (`localhost:<port>`, host mode).
> `/health` peut, lui, être public (derrière le reverse-proxy).

---

## Couche 2 — Uptime Kuma + ntfy

### a. Déployer Kuma sur le VPS
```bash
scp monitoring/deploy.sh root@87.106.6.144:/root/
ssh root@87.106.6.144 'bash /root/deploy.sh'
```
Le script écrit `/monitoring/docker-compose.yml`, pull et lance le conteneur
(idempotent, ne touche pas à `/monitoring/data`).

Le dashboard écoute sur `127.0.0.1:3001` (jamais exposé). On y accède par tunnel
SSH depuis le Mac — il est **déjà inclus** dans le lanceur commun :
```bash
./posteio/startsshtunnelfordev.sh   # ouvre webmail 8443 + SMTP 1587 + Kuma 3001
```
puis ouvrir `http://localhost:3001` et créer le compte admin (au 1er lancement).

### b. Recevoir les alertes sur ton smartphone (ntfy)

**ntfy** est le canal mobile le plus simple : aucun compte, aucun token, aucun
chat id. Tu t'abonnes à un **sujet** (une simple chaîne), et Kuma y publie les
alertes → notif push sur le téléphone. C'est **indépendant de l'email** — donc tu
es prévenu même si c'est justement le serveur mail qui tombe.

**Sur le téléphone (une fois) :**
1. Installer l'appli **ntfy** (App Store / Play Store).
2. **Subscribe to topic** → choisir un nom **long et imprévisible**, p. ex.
   `webgamerank-alerts-8f3k2z`. ⚠️ Sur le serveur public `ntfy.sh`, **qui connaît
   le sujet reçoit les messages** : c'est ce nom secret qui protège, pas un mot de
   passe. Garde-le privé (ne le commite pas).

**Brancher dans Kuma :**
3. Kuma → **Settings → Notifications → Setup Notification** → type **ntfy** :
   - **ntfy URL / Server** : `https://ntfy.sh`
   - **Topic** : `webgamerank-alerts-8f3k2z` (le même qu'à l'étape 2)
   - **Priority** : `High` (5) pour que ça sonne
   → **Test** : tu dois recevoir un push sur le tél. → **Save**.
4. Cocher **« Default enabled »** et **« Apply on all existing monitors »** pour
   que tous les moniteurs alertent via ce canal.

**Pour que ça sonne vraiment :**
5. Dans l'appli ntfy, ne pas mettre le sujet en sourdine ; vérifier que les
   notifications ntfy sont autorisées au niveau **iOS/Android**.

> Test en ligne de commande (facultatif) :
> ```bash
> curl -d "test alerte" https://ntfy.sh/webgamerank-alerts-8f3k2z
> ```
> Tu dois recevoir le push immédiatement.

> Astuce : tu peux aussi installer **Uptime Kuma en PWA** sur le téléphone
> (dashboard via le tunnel → « Ajouter à l'écran d'accueil ») pour consulter
> l'état à la demande. Mais les **alertes push**, c'est ntfy qui les délivre.

### c. Le nom du sujet ntfy est ta seule protection
Sur `ntfy.sh` (public), le sujet joue le rôle de secret : garde-le imprévisible
et hors du dépôt. Il vit dans la config Kuma (volume `/monitoring/data`). Besoin
de plus d'étanchéité plus tard ? On pourra **auto-héberger ntfy** (un conteneur)
avec sujets protégés par token.

### d. Les moniteurs à créer

> 🔌 **Kuma tourne en `network_mode: host`** (cf. `monitoring/docker-compose.yml`)
> → il partage la pile réseau de l'hôte. On vise donc les services par
> **`localhost:<port>`**, y compris ceux publiés sur `127.0.0.1` (webmail 8443,
> futur `/health` de l'app). C'est ce qui rend le webmail sondable — contrairement
> au bridge classique où `127.0.0.1` de l'hôte est injoignable.

Cadence choisie : **1 vérification toutes les 30 min** (`1800 s`) pour tous les
moniteurs — c'est le champ *Heartbeat Interval* de chaque moniteur Kuma.

#### À créer MAINTENANT — serveur mail + infra (déjà en place)

| Nom | Type | Cible | Intervalle | Déclencheur |
|-----|------|-------|-----------|-------------|
| Webmail/admin Poste.io | HTTP(s) | `https://localhost:8443` (Ignore TLS: ON) | 30 min | down |
| SMTP submission (587) | TCP Port | `localhost` : `587` | 30 min | port fermé |
| SMTP réception (25) | TCP Port | `localhost` : `25` | 30 min | port fermé |
| Conteneur Poste.io | Docker | `posteio-mail-1` | 30 min | not running / unhealthy |

Pour les moniteurs **Docker** : Settings → **Docker Hosts** → Add →
`unix:///var/run/docker.sock` (socket monté en lecture seule).

> 🔒 Le webmail a un **certif auto-signé** (pas de Let's Encrypt, cf.
> `posteio/docker-compose.yml`) → sur ce moniteur, activer **« Ignore TLS/SSL
> error »**, sinon Kuma le marque DOWN à cause du certif alors qu'il répond.

> 💡 Sans host mode (bridge classique), `localhost:8443` serait injoignable
> depuis Kuma : `host.docker.internal` ne voit que les ports publiés sur
> `0.0.0.0` (25/587/993), pas ceux liés à `127.0.0.1` (8443). Le host mode
> supprime cette limite — d'où le choix retenu.

> ⚠️ Ces moniteurs disent « le serveur mail est **up** ». Ils ne disent PAS
> « l'**auth/envoi** marche » (le `500 plugin timeout` passerait inaperçu, le 587
> répondait quand même) — ça, c'est `/health/email`, dans l'app.

#### À ajouter APRÈS le déploiement de l'app WebGameRank

⚠️ L'app **n'est pas encore déployée** (aucun conteneur `gamerank-*` dans
`docker ps`). Repère les ports : **Postgres = `5432`** (`analytics-db-1`) ; le
`3000/tcp` visible = **umami** (analytics), interne à son conteneur — **rien n'est
publié sur le port 3000 de l'hôte**. L'app tournera en conteneur derrière **Caddy**
(comme `contentrank`/`pixmem`, liée en `127.0.0.1:<port>->3000`).

| Nom | Type | Cible | Déclencheur |
|-----|------|-------|-------------|
| App liveness | HTTP(s) | `https://webgamerank.com/health` (via Caddy — public OK) | code ≠ 200 |
| App readiness (DB) | HTTP(s) - keyword | `http://localhost:<port>/health/ready`, `"db":true` | 503 / absent |
| **Email santé (auth+envoi)** | HTTP(s) - keyword | `http://localhost:<port>/health/email`, `"ok":true` | 503 / absent |
| Site public | HTTP(s) | `https://webgamerank.com` | down |
| Conteneur app | Docker | `gamerank-api` (nom réel au déploiement) | not running |

> Grâce au **host mode**, l'app liée en `127.0.0.1:<port>->3000` est joignable
> par `http://localhost:<port>/…` — plus besoin de partager un réseau Docker.
> `<port>` = le port hôte choisi au déploiement (ex. `127.0.0.1:23000->3000` →
> `<port>` = `23000`). `/health` (liveness) peut aussi passer par l'URL publique
> Caddy ; `/health/email` reste **interne** (il expose des messages d'erreur).

Réglages par moniteur : **Retries = 1** (une 2ᵉ vérif avant d'alerter),
**Resend every 1** (relance la notif à chaque battement tant que c'est down).

> À 30 min d'intervalle, une panne est vue en 30 min–1 h. Pour une détection plus
> rapide sur l'essentiel, repasse *App liveness* / *Email santé* à `60–120 s`.

---

## Couche 3 — Serveur & délivrabilité

Ce que Kuma ne voit pas tout seul :

- **RAM / disque du VPS.** Le `500 plugin timeout` d'auth vient souvent d'un VPS
  à court de RAM. Ajouter un moniteur **Push** : un cron ping une URL Kuma tant
  que `free`/`df` sont sous seuil ; si le ping s'arrête → alerte.
  ```bash
  # /etc/cron.d : toutes les 5 min, ne ping QUE si RAM libre > 100 Mo et disque < 90 %
  */5 * * * * root free -m | awk '/Mem:/{f=$7} END{exit !(f>100)}' && \
    df / | awk 'END{gsub("%","",$5); exit !($5<90)}' && \
    curl -fsS -m 10 https://localhost:3001/api/push/<TOKEN_PUSH> >/dev/null
  ```
- **Sauvegardes** : `/posteio/data` (DKIM + comptes) et `/monitoring/data`
  (config Kuma) sont les volumes à sauvegarder. Un `pg_dump` quotidien pour la DB.
- **Délivrabilité** (à surveiller, pas juste « le port répond ») :
  - vérifier périodiquement le score sur https://www.mail-tester.com (viser 10/10) ;
  - surveiller les blacklists de l'IP (ex. https://mxtoolbox.com/blacklists.aspx) ;
  - garder SPF / DKIM / DMARC / PTR alignés (cf. `doc/EMAIL-SETUP.md`).
  Ces contrôles sont plus simples en rappel mensuel qu'en automatisation.

### Canary bout-en-bout (optionnel, le plus fiable)
`/health/email` teste la **connexion + auth** en continu — c'est déjà un très bon
signal. Pour tester un **envoi réel qui arrive vraiment**, ajouter un moniteur
**Push** alimenté par un cron qui envoie un mail de test et confirme la remise
(ex. vers une boîte dédiée relevée en IMAP), puis ping Kuma. Si l'envoi casse, le
ping s'arrête → alerte. À monter une fois l'app déployée sur le VPS.

---

## Résumé « au moindre pépin »

1. **App KO / DB KO** → moniteurs *liveness* / *readiness* → push ntfy.
2. **Envoi mail cassé** (tunnel, auth, Poste.io) → moniteur *Email santé*
   (`/health/email` en 503) → push ntfy.
3. **Conteneur mail arrêté / port fermé** → moniteurs *Docker* / *TCP* → push ntfy.
4. **VPS saturé** → moniteur *Push* RAM/disque → push ntfy.
5. **Délivrabilité** (blacklist, DKIM) → contrôle périodique manuel.
