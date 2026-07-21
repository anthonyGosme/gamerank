# Déploiement & environnements — WebGameRank

Trois environnements, pilotés par [`run.sh`](../run.sh) :

| Env | Où | Base | Accès |
|-----|-----|------|-------|
| **dev** | process locaux + infra docker | Postgres/ClickHouse locaux | http://localhost:3000 |
| **homol** | stack docker EN LOCAL | Postgres/ClickHouse **isolés** (`*-homol`) | https://webgamerank.hml (Caddy local) |
| **prod** | stack docker sur le VPS | dédiée | https://webgamerank.com (Caddy du serveur) — *à venir* |

---

## Homol — validation dockerisée en local

Objectif : faire tourner l'app **comme en prod** (image docker, derrière un
reverse-proxy HTTPS sur un vrai domaine) pour attraper les écarts prod-only
(cookies `Secure`, `trustProxy`/`X-Forwarded`, `APP_URL` absolue).

### 1. Domaine local — `/etc/hosts`
Ajouter une fois :
```
127.0.0.1 webgamerank.hml
```

### 2. Reverse-proxy — Caddy local
`run.sh` **ne gère pas Caddy** (comme pour les autres projets) : il suppose un
Caddy déjà lancé sur le Mac. Ajouter ce bloc à ton `Caddyfile` puis recharger
Caddy (`caddy reload` ou `brew services restart caddy`) :

```caddy
webgamerank.hml {
    reverse_proxy 127.0.0.1:18001
    tls internal
}
```
- `tls internal` = certificat émis par la CA locale de Caddy. Si le navigateur
  râle, faire confiance à la CA une fois : `caddy trust`.
- La stack homol expose l'API sur `127.0.0.1:18001` ; Caddy fait le pont HTTPS.

### 3. Lancer
```bash
./run.sh dev tunnels     # (si pas déjà ouverts) → email homol via host.docker.internal:1587
./run.sh homol start     # build image + infra isolée + migrations + API + seed
```
Puis ouvrir **https://webgamerank.hml**.

### Commandes homol
```bash
./run.sh homol status         # état des conteneurs + /health
./run.sh homol logs           # logs suivis
./run.sh homol migrate        # migrations dans le conteneur
./run.sh homol seed [--sample]# (re)seed idempotent des 10 jeux démo
./run.sh homol db-backup       # dump Postgres homol → backups/
./run.sh homol stop|restart    # arrêt (volumes conservés) / redémarrage
```

### Notes
- **Base isolée** : volumes `pgdata-homol`, `chdata-homol`, `uploads-homol` —
  jamais partagés avec dev. `./run.sh homol stop` conserve les volumes.
- **Email** : la stack pointe le SMTP sur `host.docker.internal:1587` → il faut
  les **tunnels SSH ouverts** sur le Mac (`./run.sh dev tunnels`) pour que les
  magic links partent réellement. `SMTP_PASS` est injecté depuis le `.env`
  racine (interpolation compose), jamais écrit en dur.
- **Seed** idempotent (voir [`apps/api/scripts/seed-demo.ts`](../apps/api/scripts/seed-demo.ts)) :
  `ON CONFLICT` + delete-puis-réinsert pour ClickHouse. `start` ne seede que si
  la base est vide ; `seed` force à la demande.

---

## Prod — à venir

Même principe qu'homol mais sur le VPS, derrière le Caddy du serveur
(`front-caddy-1`) : `compose.prod.yaml`, base dédiée, `APP_URL=https://webgamerank.com`,
SMTP en direct sur Poste.io (même VPS, sans tunnel), et un `./run.sh prod deploy`
par transfert d'image (`docker save | ssh | docker load`). À construire à l'étape
suivante.
