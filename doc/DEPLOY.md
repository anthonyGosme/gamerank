# Déploiement & environnements — WebGameRank

Trois environnements, pilotés par [`run.sh`](../run.sh) :

| Env | Où | Base | Accès |
|-----|-----|------|-------|
| **dev** | process locaux + infra docker | Postgres/ClickHouse locaux | http://localhost:3000 |
| **homol** | stack docker EN LOCAL | Postgres/ClickHouse **isolés** (`*-homol`) | https://webgamerank.hml (Caddy local) |
| **prod** | stack docker sur le VPS | dédiée | https://webgamerank.com (Caddy du serveur) |

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

## Prod — VPS

La production est pilotée depuis le dépôt local. Le déploiement construit les
deux images, les transfère sans registre privé, sauvegarde PostgreSQL, joue les
migrations, démarre l'API et exécute les smoke tests.

### 1. Secrets

```bash
./run.sh prod init
# compléter ADMIN_EMAILS, SMTP_USER et SMTP_PASS
```

`init` génère les mots de passe PostgreSQL/ClickHouse et le salt tripwire,
applique les permissions `600` et ne remplace jamais un `.env.prod` existant.

`.env.prod` est ignoré par Git. Il est copié dans `/opt/webgamerank/.env.prod`
avec des permissions `600`. Les mots de passe PostgreSQL et ClickHouse ne
doivent plus être changés directement après la création des volumes : utiliser
une procédure de rotation dédiée.

### 2. Réseau Caddy

La stack rejoint par défaut le réseau Docker externe `edge`, qui est le réseau
actuellement utilisé par `front-caddy-1`. Pour le revérifier sur le VPS :

```bash
ssh root@87.106.6.144 'docker network ls'
```

Si le réseau du conteneur Caddy porte un autre nom, renseigner
`PROD_PROXY_NETWORK` dans `.env.prod`.

Bloc à ajouter au Caddyfile de `webgamerank.com` :

```caddy
webgamerank.com {
    handle_path /demo/* {
        reverse_proxy gamerank-demo:4600
    }
    handle {
        reverse_proxy gamerank-api:3000
    }
}
```

Le routage `/demo/*` est nécessaire au pool initial de jeux. L'API et les jeux
restent aussi liés à `127.0.0.1:23000` et `127.0.0.1:23001` pour les sondes Kuma
internes ; ils ne sont pas exposés publiquement sans Caddy.

### 3. Premier déploiement et suivants

```bash
./run.sh prod deploy
./run.sh prod status
./run.sh prod logs
```

Au premier déploiement uniquement, si `games` est vide, les 10 jeux de
démonstration sont injectés et leur configuration est partagée avec
`demo-game`. Ils constituent le pool de jury nécessaire aux premières
inscriptions. Une base contenant déjà au moins un jeu n'est jamais reseedée
automatiquement.

Chaque déploiement ultérieur :

1. conserve les volumes PostgreSQL, ClickHouse, uploads et configuration démo ;
2. crée un dump `backups/gamerank-prod-pre-deploy-*.sql.gz` ;
3. applique les migrations avant le remplacement de l'API ;
4. restaure automatiquement l'image applicative précédente si le démarrage ou
   les smoke tests locaux échouent ;
5. vérifie ensuite `/health` et `/` à travers l'URL publique.

Les migrations doivent donc rester rétrocompatibles avec l'image précédente.
Le rollback d'image ne défait volontairement pas une migration de données.

### 4. Exploitation

```bash
./run.sh prod db-backup manuel
./run.sh prod migrate
./run.sh prod seed            # manuel et idempotent, pas nécessaire au deploy normal
./run.sh prod logs
```

Les sauvegardes restent sur le VPS dans `/opt/webgamerank/backups`. Une copie
hors VPS doit être automatisée avant de considérer la reprise après sinistre
comme complète. Voir aussi [PROD-CHECKLIST.md](PROD-CHECKLIST.md).
