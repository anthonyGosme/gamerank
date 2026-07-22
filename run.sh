#!/usr/bin/env bash
# run.sh : point d'entrée unique de gestion pour WebGameRank.
#
# Grammaire : ./run.sh <env> <action> [args]
# Envs      : dev (local + infra docker) · homol (docker local) · prod (docker VPS)
# Global    : ./run.sh status
#
# Lancer ./run.sh sans argument pour la référence complète.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ─── Constantes ───────────────────────────────────────────────────────────────
VPS="${GR_VPS:-root@87.106.6.144}"     # VPS Poste.io / Kuma (tunnels + prod)
BACKUP_DIR="backups"
HOMOL_COMPOSE="compose.homol.yaml"
PROD_COMPOSE="compose.prod.yaml"
PROD_ENV=".env.prod"
PROD_REMOTE_DIR="${GR_PROD_DIR:-/opt/webgamerank}"

DEV_API_PORT=3000                       # apps/api (tsx watch)
DEV_DEMO_PORT=4600                      # apps/demo-game
MAILPIT_UI_PORT=8025                    # UI Mailpit (dev, non utilisé si SMTP réel)

# Ports locaux ouverts par les tunnels SSH (posteio/startsshtunnelfordev.sh)
TUNNEL_SMTP_PORT=1587                   # → 587 du serveur (envoi authentifié)
TUNNEL_KUMA_PORT=3001                   # → 3001 (dashboard Uptime Kuma)
TUNNEL_WEBMAIL_PORT=8443                # → 443 (webmail/admin Poste.io)
TUNNEL_SIG="${TUNNEL_KUMA_PORT}:localhost:${TUNNEL_KUMA_PORT}"  # signature pgrep

if [[ -t 1 ]]; then
  GREEN='\033[32m' RED='\033[31m' YELLOW='\033[33m' BOLD='\033[1m' RESET='\033[0m'
else
  GREEN='' RED='' YELLOW='' BOLD='' RESET=''
fi
say()  { echo -e "${GREEN}→${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
die()  { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
run.sh : point d'entrée unique de gestion pour WebGameRank.

Grammaire : ./run.sh <env> <action> [args]

Environnements :
  dev     processus locaux + infra docker (Postgres/ClickHouse/Mailpit)
          api http://localhost:3000 · demo http://localhost:4600
  homol   stack dockerisée de validation EN LOCAL (compose.homol.yaml)
          base Postgres+ClickHouse isolées · API sur 127.0.0.1:18001
          accès https://webgamerank.hml via /etc/hosts + le Caddy local
  prod    stack dockerisée déployée sur le VPS derrière Caddy

Actions dev :
  start                 infra + migrations + build SDK + demo-game + api + tunnels
  stop                  arrête api + demo-game + tunnels (l'infra docker reste up)
  restart               stop puis start
  status                état des services, DB, /health, /health/email, tunnels
  logs                  suit logs/dev.log
  test [args]           suite de tests (apps/api) ; args transmis
  migrate               joue les migrations Postgres
  build-sdk             (re)build packages/sdk (/sdk.js, /widget.js)
  seed [--sample]       jeux de démo (SEED_SAMPLE=1 avec --sample)
  infra-up|infra-down   démarre/arrête l'infra docker (Postgres/ClickHouse/Mailpit)
  tunnels|tunnels-stop  (ré)ouvre / ferme les tunnels SSH (SMTP + Kuma + webmail)
  email-check           interroge /health/email (connexion + auth SMTP)
  email-test <dest>     envoie un vrai email de test (nécessite les tunnels)
  db-backup [label]     dump Postgres → backups/gamerank-dev-<ts>[-label].sql.gz
  db-restore <f|latest> restaure un dump (sauvegarde auto d'abord). App arrêtée.
  db-reset [--yes]      sauvegarde → schéma vierge → migrations. App arrêtée.

Actions homol (docker) :
  build                 build de l'image API
  start                 build + infra isolée + migrations + API + seed (si base vide)
  stop | restart        arrêt (volumes conservés) / redémarrage
  status | logs         état de la stack + /health / suivi des logs
  migrate               joue les migrations dans le conteneur
  seed [--sample]       seed des jeux de démo dans le conteneur (idempotent)
  db-backup [label]     dump Postgres de la stack homol

Actions prod (VPS distant) :
  init                  crée .env.prod, génère les secrets techniques, chmod 600
  deploy                build + transfert + backup + migrations + bootstrap + smoke tests
  status                état distant des conteneurs et endpoints de santé
  logs                  suit les logs distants de l'API
  migrate               rejoue les migrations sur le VPS
  seed [--sample]       seed manuel distant (le deploy ne seede que si base vide)
  db-backup [label]     dump PostgreSQL distant dans /opt/webgamerank/backups

Commandes globales :
  status                les trois environnements d'un coup d'œil

Notes :
  - Les tunnels SSH (email + Kuma) passent par $GR_VPS (défaut root@87.106.6.144).
  - homol expose 127.0.0.1:18001 ; le reverse-proxy HTTPS est assuré par un
    Caddy local (non géré par run.sh) : voir doc/DEPLOY.md pour le bloc Caddy et
    la ligne /etc/hosts (webgamerank.hml → 127.0.0.1).
  - homol email : via le tunnel SSH (host.docker.internal:1587) → garde les
    tunnels ouverts (./run.sh dev tunnels) pour que les magic links partent.
  - prod exige .env.prod (voir .env.prod.example) et le réseau Docker du Caddy.
  - le premier deploy sur base vide injecte volontairement les 10 jeux démo
    afin d'amorcer le jury des premières inscriptions.
EOF
  exit 2
}

# ─── Résolution du contexte d'environnement ───────────────────────────────────
resolve_env() {
  ENV_NAME="$1"
  case "$1" in
    dev)
      ENV_KIND="local"; COMPOSE_FILE=""; PORT="$DEV_API_PORT"
      PUBLIC_URL="http://localhost:$DEV_API_PORT" ;;
    homol)
      ENV_KIND="docker"; COMPOSE_FILE="$HOMOL_COMPOSE"; PORT=18001
      PUBLIC_URL="https://webgamerank.hml" ;;
    prod)
      ENV_KIND="docker"; COMPOSE_FILE="$PROD_COMPOSE"; PORT=23000
      PUBLIC_URL="https://webgamerank.com" ;;
    *) die "env inconnu '$1' (dev|homol|prod)" ;;
  esac
}

# ─── Helpers ──────────────────────────────────────────────────────────────────
timestamp() { date '+%Y%m%d-%H%M%S'; }
is_local() { [[ "$ENV_KIND" == "local" ]]; }
# URL publique des jeux de démo pour cet env (le demo est monté sous /demo).
demo_base_url() {
  if is_local; then echo "http://localhost:$DEV_DEMO_PORT/demo"; else echo "$PUBLIC_URL/demo"; fi
}

# Infra docker partagée (docker-compose.yml à la racine : Postgres/ClickHouse/Mailpit)
infra() {
  command -v docker >/dev/null || die "docker non installé / absent du PATH"
  docker compose "$@"
}

port_listening() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-3}" "$1" 2>/dev/null || echo '000'; }

wait_postgres() {
  say "attente de Postgres..."
  for _ in $(seq 1 30); do
    if infra exec -T postgres pg_isready -U gamerank -q 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  die "Postgres n'est pas prêt (infra démarrée ? ./run.sh dev infra-up)"
}

# ─── Infra docker ─────────────────────────────────────────────────────────────
act_infra_up() {
  require_dev
  infra up -d
  say "infra docker up : Postgres :5432 · ClickHouse :8123 · Mailpit UI :$MAILPIT_UI_PORT"
}
act_infra_down() { require_dev; infra down; say "infra docker arrêtée (données conservées dans les volumes)"; }

# ─── Tunnels SSH ──────────────────────────────────────────────────────────────
tunnels_running() { pgrep -f "$TUNNEL_SIG" >/dev/null 2>&1; }

print_tunnel_urls() {
  echo "    VPS (ssh)              → ssh $VPS"
  echo "    Uptime Kuma            → http://localhost:$TUNNEL_KUMA_PORT"
  echo "    webmail / admin Poste  → https://localhost:$TUNNEL_WEBMAIL_PORT/admin/  (certif auto-signé)"
  echo "    SMTP (envoi)           → localhost:$TUNNEL_SMTP_PORT  (port mail, pas d'URL)"
}

act_tunnels() {
  require_dev
  if tunnels_running; then
    say "tunnels SSH déjà ouverts :"
    print_tunnel_urls
    return 0
  fi
  # Vérifie l'accès SSH sans bloquer sur un prompt.
  if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$VPS" true 2>/dev/null; then
    warn "SSH vers $VPS impossible (clé/agent ?) — tunnels non ouverts."
    warn "email-test et le webmail resteront indisponibles jusqu'à ce que ssh $VPS marche."
    return 0
  fi
  mkdir -p logs
  nohup bash posteio/startsshtunnelfordev.sh >> logs/tunnels.log 2>&1 &
  sleep 2
  if tunnels_running; then
    say "tunnels SSH ouverts :"
    print_tunnel_urls
  else
    warn "les tunnels ne se sont pas ouverts — voir logs/tunnels.log"
  fi
}

act_tunnels_stop() {
  require_dev
  if tunnels_running; then
    pkill -f "$TUNNEL_SIG" 2>/dev/null || true
    say "tunnels SSH fermés"
  else
    say "aucun tunnel ouvert"
  fi
}

# ─── start / stop / restart (dev) ─────────────────────────────────────────────
require_dev() { [[ "$ENV_KIND" == "local" ]] || die "action réservée à dev"; }

act_start() {
  require_dev
  [[ -f .env ]] || die ".env manquant (cp .env.example .env puis renseigner)"
  mkdir -p logs
  act_infra_up
  wait_postgres
  say "migrations..."; npm run --silent migrate >> logs/dev.log 2>&1 || die "migrations en échec (voir logs/dev.log)"
  say "build SDK..."; npm run --silent build:sdk >> logs/dev.log 2>&1 || die "build SDK en échec (voir logs/dev.log)"

  # Seed des 10 jeux de démo uniquement si la base est vide (sinon inutile : le
  # seeder est idempotent, mais on évite de recalculer les scores à chaque start).
  local ngames; ngames="$(pg psql -U gamerank -d gamerank -tAc 'SELECT count(*) FROM games' 2>/dev/null | tr -d '[:space:]')"
  if [[ "${ngames:-0}" == "0" ]]; then
    say "seed des 10 jeux de démo (base vide)..."
    DEMO_BASE_URL="$(demo_base_url)" npm run --silent seed:demo >> logs/dev.log 2>&1 || warn "seed échoué (voir logs/dev.log)"
  else
    say "jeux en base : ${ngames} (pas de re-seed ; ./run.sh dev seed pour forcer)"
  fi

  if port_listening "$DEV_DEMO_PORT"; then
    warn "demo-game déjà sur :$DEV_DEMO_PORT (laissé tel quel)"
  else
    say "demo-game → http://localhost:$DEV_DEMO_PORT"
    # Lancé avec le chemin complet pour que `dev stop` puisse le cibler (pkill).
    PORT="$DEV_DEMO_PORT" nohup node apps/demo-game/server.js >> logs/dev.log 2>&1 &
  fi

  if port_listening "$DEV_API_PORT"; then
    warn "api déjà sur :$DEV_API_PORT (laissé tel quel)"
  else
    say "api → http://localhost:$DEV_API_PORT"
    nohup npm run --silent dev >> logs/dev.log 2>&1 &
  fi

  act_tunnels
  sleep 1
  say "logs : ./run.sh dev logs   ·   arrêt : ./run.sh dev stop"
}

act_stop() {
  require_dev
  say "arrêt des services locaux..."
  pkill -f "src/server.ts" 2>/dev/null && say "  api arrêtée" || true
  pkill -f "tsx watch" 2>/dev/null || true
  pkill -f "apps/demo-game/server.js" 2>/dev/null && say "  demo-game arrêté" || true
  act_tunnels_stop
  sleep 1
  # Libère les ports dev — mais UNIQUEMENT si un process `node` les tient. Un
  # conteneur (ex. demo-game homol qui mappe 127.0.0.1:4600) est servi par le
  # proxy de Docker Desktop : le tuer plante Docker. On ne touche jamais à ça.
  local p cmd
  for port in "$DEV_API_PORT" "$DEV_DEMO_PORT"; do
    p="$(lsof -nP -tiTCP:$port -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
    [[ -n "$p" ]] || continue
    cmd="$(ps -p "$p" -o comm= 2>/dev/null || true)"
    if [[ "$cmd" == *node* ]]; then
      kill -9 "$p" 2>/dev/null || true; say "  port $port libéré (pid $p)"
    else
      warn "  port $port tenu par '$cmd' (pid $p) — laissé (probablement Docker/homol)"
    fi
  done
  say "arrêté (infra docker toujours up : ./run.sh dev infra-down pour l'arrêter)."
}

act_restart() { act_stop; act_start; }

# ─── status ───────────────────────────────────────────────────────────────────
svc_line() {
  local label="$1" port="$2"
  if port_listening "$port"; then echo "  $label : up (:$port)"; else echo "  $label : down (:$port)"; fi
}

act_status() {
  if [[ "$ENV_KIND" != "local" ]]; then
    echo -e "${BOLD}$ENV_NAME (docker)${RESET}"
    if [[ -f "$COMPOSE_FILE" ]]; then
      local ps; ps="$(docker compose -p "webgamerank-$ENV_NAME" -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.Status}}' 2>/dev/null || true)"
      if [[ -n "$ps" ]]; then echo "$ps" | sed 's/^/  /'; else echo "  (stack arrêtée)"; fi
      local h; h="$(http_code "http://localhost:$PORT/health")"
      echo "  /health : HTTP $h $([[ "$h" == "200" ]] && echo ✓ || echo ✗)  (local :$PORT)"
    else
      echo "  non configuré — $COMPOSE_FILE absent (déploiement dockerisé à venir)"
    fi
    echo "  url : $PUBLIC_URL"
    return 0
  fi

  echo -e "${BOLD}dev (local · $(hostname -s))${RESET}"
  svc_line "api      " "$DEV_API_PORT"
  svc_line "demo-game" "$DEV_DEMO_PORT"

  # Infra docker
  local infra_ps
  infra_ps="$(infra ps --format '{{.Service}} {{.State}}' 2>/dev/null || true)"
  if [[ -n "$infra_ps" ]]; then
    echo "  infra    :"; echo "$infra_ps" | sed 's/^/    /'
  else
    echo "  infra    : arrêtée (./run.sh dev infra-up)"
  fi

  # Santé applicative
  local h he
  h="$(http_code "http://localhost:$DEV_API_PORT/health")"
  echo "  /health          : HTTP $h $([[ "$h" == "200" ]] && echo ✓ || echo ✗)"
  if [[ "$h" == "200" ]]; then
    he="$(curl -s --max-time 40 "http://localhost:$DEV_API_PORT/health/email" 2>/dev/null || echo '')"
    if echo "$he" | grep -q '"ok":true'; then
      echo "  /health/email    : ✓ SMTP joignable"
    elif [[ -n "$he" ]]; then
      echo "  /health/email    : ✗ $(echo "$he" | tr -d '\n' | cut -c1-120)"
    else
      echo "  /health/email    : ? pas de réponse"
    fi
  fi

  # Tunnels
  echo "  tunnels  :"
  echo "    SMTP    :$TUNNEL_SMTP_PORT    $(port_listening "$TUNNEL_SMTP_PORT" && echo up || echo down)"
  echo "    Kuma    :$TUNNEL_KUMA_PORT    $(port_listening "$TUNNEL_KUMA_PORT" && echo 'up → http://localhost:'"$TUNNEL_KUMA_PORT" || echo down)"
  echo "    webmail :$TUNNEL_WEBMAIL_PORT    $(port_listening "$TUNNEL_WEBMAIL_PORT" && echo 'up → https://localhost:'"$TUNNEL_WEBMAIL_PORT" || echo down)"
  echo "  app (site)     : $PUBLIC_URL $(port_listening "$DEV_API_PORT" && echo '✓ up' || echo '✗ down — ./run.sh dev start')"
  echo "  URL du jeu dev : http://localhost:$DEV_DEMO_PORT/demo/ $(port_listening "$DEV_DEMO_PORT" && echo '✓' || echo '✗ down')"
}

act_logs() {
  require_dev
  [[ -f logs/dev.log ]] || die "aucun log (démarrez : ./run.sh dev start)"
  exec tail -f logs/dev.log
}

# ─── test / migrate / build-sdk / seed ────────────────────────────────────────
act_test() {
  local status=0
  npm run --silent test -- "$@" || status=$?
  (( status == 0 )) || die "tests en échec (code $status)"
  say "tests OK"
}
act_migrate()   { npm run --silent migrate; say "migrations à jour"; }
act_build_sdk() { npm run --silent build:sdk; say "SDK build (/sdk.js, /widget.js)"; }
act_seed() {
  local base; base="$(demo_base_url)"
  if [[ "${1:-}" == "--sample" ]]; then DEMO_BASE_URL="$base" SEED_SAMPLE=1 npm run --silent seed:demo; else DEMO_BASE_URL="$base" npm run --silent seed:demo; fi
  say "jeux de démo insérés"
}

# ─── email ────────────────────────────────────────────────────────────────────
act_email_check() {
  require_dev
  port_listening "$DEV_API_PORT" || die "api down — ./run.sh dev start"
  say "interrogation de /health/email (verify SMTP)..."
  local body
  body="$(curl -s --max-time 40 "http://localhost:$DEV_API_PORT/health/email" || true)"
  echo "$body"
  echo "$body" | grep -q '"ok":true' && say "SMTP joignable ✓" || die "SMTP KO (tunnels ouverts ? SMTP_PASS correct ?)"
}

act_email_test() {
  require_dev
  local to="${1:-}"
  [[ -n "$to" ]] || die "usage : ./run.sh dev email-test <destinataire>"
  port_listening "$TUNNEL_SMTP_PORT" || warn "tunnel SMTP :$TUNNEL_SMTP_PORT fermé — l'envoi va probablement échouer (./run.sh dev tunnels)"
  say "envoi d'un email de test à $to..."
  npx tsx --env-file=.env apps/api/scripts/send-test-email.ts "$to"
}

# ─── db-backup / db-restore / db-reset (Postgres) ─────────────────────────────
# Cible la bonne base selon l'env : infra docker partagée en dev, stack dédiée
# en homol/prod.
pg() {
  if [[ "$ENV_KIND" == "local" ]]; then infra exec -T postgres "$@"; else docker_compose exec -T postgres "$@"; fi
}

do_backup() {
  local label="${1:-}"
  mkdir -p "$BACKUP_DIR"
  local name="gamerank-$ENV_NAME-$(timestamp)${label:+-$label}.sql.gz"
  if ! pg pg_dump -U gamerank -d gamerank 2>/dev/null | gzip > "$BACKUP_DIR/$name"; then
    rm -f "$BACKUP_DIR/$name"; warn "dump impossible (stack $ENV_NAME up ?)"; return 1
  fi
  say "sauvegardé → $BACKUP_DIR/$name ($(du -h "$BACKUP_DIR/$name" | cut -f1 | tr -d ' '))"
  echo "$BACKUP_DIR/$name"
}
act_db_backup() { do_backup "${1:-}" >/dev/null; }

act_db_restore() {
  require_dev
  local src="${1:-}"
  [[ -n "$src" ]] || die "usage : ./run.sh dev db-restore <backups/fichier.sql.gz | latest>"
  if [[ "$src" == "latest" ]]; then
    src="$(ls -t "$BACKUP_DIR"/gamerank-dev-*.sql.gz 2>/dev/null | head -1 || true)"
    [[ -n "$src" ]] || die "aucune sauvegarde dev dans $BACKUP_DIR/"
  fi
  [[ -f "$src" ]] || die "sauvegarde introuvable : $src"
  port_listening "$DEV_API_PORT" && die "arrêtez l'app d'abord : ./run.sh dev stop"
  do_backup "pre-restore" >/dev/null || true
  say "schéma vierge puis restauration de $src..."
  pg psql -U gamerank -d gamerank -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
  gunzip -c "$src" | pg psql -U gamerank -d gamerank >/dev/null
  say "restauré $src"
}

act_db_reset() {
  require_dev
  local yes="${1:-}"
  port_listening "$DEV_API_PORT" && die "arrêtez l'app d'abord : ./run.sh dev stop"
  if [[ "$yes" != "--yes" ]]; then
    echo -e "${YELLOW}Ceci efface la base dev (sauvegarde auto avant).${RESET}"
    read -r -p "Tapez 'reset' pour confirmer : " answer
    [[ "$answer" == "reset" ]] || die "annulé"
  fi
  do_backup "pre-reset" >/dev/null || true
  pg psql -U gamerank -d gamerank -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
  npm run --silent migrate
  say "base dev réinitialisée (schéma recréé via migrations)."
}

# ─── Stack docker (homol / prod) ──────────────────────────────────────────────
docker_compose() {
  command -v docker >/dev/null || die "docker requis"
  [[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]] \
    || die "$COMPOSE_FILE absent — env $ENV_NAME pas encore configuré"
  docker compose -p "webgamerank-$ENV_NAME" -f "$COMPOSE_FILE" "$@"
}

dc_wait_pg() {
  say "attente Postgres ($ENV_NAME)..."
  for _ in $(seq 1 40); do
    docker_compose exec -T postgres pg_isready -U gamerank -q 2>/dev/null && return 0
    sleep 1
  done
  die "Postgres ($ENV_NAME) pas prêt"
}

dc_games_count() {
  docker_compose exec -T postgres psql -U gamerank -d gamerank -tAc 'SELECT count(*) FROM games' 2>/dev/null | tr -d '[:space:]'
}

act_docker_build() { say "build de l'image API ($ENV_NAME)..."; docker_compose build; say "image prête"; }

act_docker_start() {
  say "build des images ($ENV_NAME)..."; docker_compose build
  say "infra isolée (postgres/clickhouse)..."; docker_compose up -d postgres clickhouse
  dc_wait_pg
  say "migrations (conteneur jetable)..."; docker_compose run --rm api node dist/migrate.js
  say "démarrage API + demo-game..."; docker_compose up -d api demo-game
  for _ in $(seq 1 30); do [[ "$(http_code "http://localhost:$PORT/health")" == "200" ]] && break; sleep 1; done
  local n; n="$(dc_games_count)"
  if [[ "${n:-0}" == "0" ]]; then
    say "seed des 10 jeux de démo (base vide)..."
    docker_compose exec -T -e DEMO_BASE_URL="$(demo_base_url)" api npx tsx /app/apps/api/scripts/seed-demo.ts || warn "seed échoué"
  else
    say "jeux en base : ${n} (pas de re-seed ; ./run.sh $ENV_NAME seed pour forcer)"
  fi
  say "$ENV_NAME up → http://localhost:$PORT   (via Caddy local : $PUBLIC_URL)"
  say "logs : ./run.sh $ENV_NAME logs   ·   arrêt : ./run.sh $ENV_NAME stop"
}

act_docker_stop()    { docker_compose down; say "stack $ENV_NAME arrêtée (volumes conservés)"; }
act_docker_restart() { act_docker_stop; act_docker_start; }
act_docker_logs()    { docker_compose logs -f --tail=100; }
act_docker_migrate() { docker_compose run --rm api node dist/migrate.js; say "migrations à jour ($ENV_NAME)"; }
act_docker_seed() {
  if [[ "${1:-}" == "--sample" ]]; then
    docker_compose exec -T -e DEMO_BASE_URL="$(demo_base_url)" -e SEED_SAMPLE=1 api npx tsx /app/apps/api/scripts/seed-demo.ts
  else
    docker_compose exec -T -e DEMO_BASE_URL="$(demo_base_url)" api npx tsx /app/apps/api/scripts/seed-demo.ts
  fi
  say "seed ($ENV_NAME) terminé"
}

# ─── Production distante ─────────────────────────────────────────────────────
prod_ssh() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$VPS" "$@"; }

prod_env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/gamerank-env.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    index($0, key "=") == 1 { print key "=" value; next }
    { print }
  ' "$PROD_ENV" > "$tmp"
  mv "$tmp" "$PROD_ENV"
}

act_prod_init() {
  if [[ -f "$PROD_ENV" ]]; then
    chmod 600 "$PROD_ENV"
    say "$PROD_ENV existe déjà — contenu conservé, permissions remises à 600"
    return 0
  fi
  command -v openssl >/dev/null || die "openssl requis pour générer les secrets"
  cp .env.prod.example "$PROD_ENV"
  chmod 600 "$PROD_ENV"
  prod_env_set PROD_PG_PASSWORD "$(openssl rand -hex 32)"
  prod_env_set PROD_CH_PASSWORD "$(openssl rand -hex 32)"
  prod_env_set TRIPWIRE_SALTS "wr2:$(openssl rand -hex 24)"
  say "$PROD_ENV créé (permissions 600)"
  warn "à compléter : ADMIN_EMAILS, SMTP_USER et SMTP_PASS"
  say "puis lancer : ./run.sh prod deploy"
}

prod_preflight() {
  [[ -f "$PROD_COMPOSE" ]] || die "$PROD_COMPOSE absent"
  [[ -f "$PROD_ENV" ]] || die "$PROD_ENV manquant (cp .env.prod.example .env.prod puis renseigner)"
  [[ -x scripts/prod-deploy-remote.sh ]] || die "scripts/prod-deploy-remote.sh doit être exécutable"
  command -v docker >/dev/null || die "docker requis en local pour construire les images"
  command -v ssh >/dev/null || die "ssh requis"
  command -v scp >/dev/null || die "scp requis"
  if grep -Eq 'CHANGE_ME|example\.com' "$PROD_ENV"; then
    die "$PROD_ENV contient encore une valeur d'exemple"
  fi
  for key in PROD_PG_PASSWORD PROD_CH_PASSWORD ADMIN_EMAILS SMTP_USER SMTP_PASS TRIPWIRE_SALTS; do
    grep -Eq "^[[:space:]]*${key}=.+" "$PROD_ENV" || die "$key manque dans $PROD_ENV"
  done
  prod_ssh "command -v docker >/dev/null && docker compose version >/dev/null" \
    || die "Docker Compose ou accès SSH indisponible sur $VPS"
}

act_prod_deploy() {
  prod_preflight
  local tmp_dir image_tar
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/gamerank-prod.XXXXXX")"
  image_tar="$tmp_dir/images.tar"
  trap 'rm -rf "$tmp_dir"' RETURN

  say "build des images de production..."
  docker build -t webgamerank-api:prod -f Dockerfile .
  docker build -t webgamerank-demo:prod apps/demo-game
  say "export des images..."
  docker save -o "$image_tar" webgamerank-api:prod webgamerank-demo:prod

  say "préparation de $VPS:$PROD_REMOTE_DIR..."
  prod_ssh "mkdir -p '$PROD_REMOTE_DIR' '$PROD_REMOTE_DIR/backups' && chmod 700 '$PROD_REMOTE_DIR'"
  scp -q "$PROD_COMPOSE" "$VPS:$PROD_REMOTE_DIR/compose.prod.yaml"
  scp -q "$PROD_ENV" "$VPS:$PROD_REMOTE_DIR/.env.prod"
  scp -q scripts/prod-deploy-remote.sh "$VPS:$PROD_REMOTE_DIR/prod-deploy-remote.sh"
  scp -q "$image_tar" "$VPS:$PROD_REMOTE_DIR/images.tar"
  prod_ssh "chmod 600 '$PROD_REMOTE_DIR/.env.prod' && chmod 700 '$PROD_REMOTE_DIR/prod-deploy-remote.sh'"

  say "backup, migrations, démarrage et smoke tests sur le VPS..."
  prod_ssh "GR_PROD_DIR='$PROD_REMOTE_DIR' '$PROD_REMOTE_DIR/prod-deploy-remote.sh'"

  local public_health public_home
  public_health="$(http_code "https://webgamerank.com/health" 10)"
  public_home="$(http_code "https://webgamerank.com/" 10)"
  if [[ "$public_health" != 200 || "$public_home" != 200 ]]; then
    warn "stack saine sur le VPS, mais Caddy/DNS public incomplet : /health=$public_health, /=$public_home"
    warn "voir doc/DEPLOY.md puis relancer : ./run.sh prod status"
  else
    say "production publique saine : https://webgamerank.com"
  fi
}

act_prod_status() {
  echo -e "${BOLD}prod (VPS $VPS)${RESET}"
  if ! prod_ssh "test -f '$PROD_REMOTE_DIR/compose.prod.yaml' && test -f '$PROD_REMOTE_DIR/.env.prod'"; then
    echo "  non déployé — ./run.sh prod deploy"
    return 0
  fi
  prod_ssh "cd '$PROD_REMOTE_DIR' && docker compose --env-file .env.prod -p webgamerank-prod -f compose.prod.yaml ps"
  echo "  public /health : HTTP $(http_code 'https://webgamerank.com/health' 10)"
  echo "  public /       : HTTP $(http_code 'https://webgamerank.com/' 10)"
}

act_prod_logs() {
  prod_ssh "cd '$PROD_REMOTE_DIR' && docker compose --env-file .env.prod -p webgamerank-prod -f compose.prod.yaml logs -f --tail=100 api"
}

act_prod_migrate() {
  prod_ssh "cd '$PROD_REMOTE_DIR' && docker compose --env-file .env.prod -p webgamerank-prod -f compose.prod.yaml run --rm api node dist/migrate.js"
  say "migrations prod à jour"
}

act_prod_seed() {
  local sample=""
  [[ "${1:-}" == "--sample" ]] && sample="-e SEED_SAMPLE=1"
  prod_ssh "cd '$PROD_REMOTE_DIR' && docker compose --env-file .env.prod -p webgamerank-prod -f compose.prod.yaml exec -T -e DEMO_BASE_URL=https://webgamerank.com/demo $sample api npx tsx /app/apps/api/scripts/seed-demo.ts"
  say "seed prod terminé"
}

act_prod_backup() {
  local label="${1:-manual}" ts name
  [[ "$label" =~ ^[a-zA-Z0-9._-]+$ ]] || die "label de backup invalide"
  ts="$(timestamp)"; name="gamerank-prod-${ts}-${label}.sql.gz"
  prod_ssh "cd '$PROD_REMOTE_DIR' && mkdir -p backups && docker compose --env-file .env.prod -p webgamerank-prod -f compose.prod.yaml exec -T postgres pg_dump -U gamerank -d gamerank | gzip > 'backups/$name'"
  say "backup prod → $VPS:$PROD_REMOTE_DIR/backups/$name"
}

# ─── Global ───────────────────────────────────────────────────────────────────
cmd_status_all() {
  for e in dev homol; do resolve_env "$e"; act_status; echo ""; done
  resolve_env prod; act_prod_status; echo ""
  echo -e "${BOLD}sauvegardes${RESET}"
  ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -5 | sed 's/^/  /' || echo "  aucune"
}

# ─── Dispatch ─────────────────────────────────────────────────────────────────
cmd="${1:-}"
case "$cmd" in
  dev|homol|prod)
    resolve_env "$cmd"
    action="${2:-}"
    shift 2 2>/dev/null || shift $# 2>/dev/null || true
    if [[ "$cmd" == "prod" ]]; then
      case "$action" in
        init)         act_prod_init ;;
        deploy)       act_prod_deploy ;;
        status)       act_prod_status ;;
        logs)         act_prod_logs ;;
        migrate)      act_prod_migrate ;;
        seed)         act_prod_seed "${1:-}" ;;
        db-backup)    act_prod_backup "${1:-}" ;;
        *) die "action inconnue pour prod — init|deploy|status|logs|migrate|seed|db-backup" ;;
      esac
      exit 0
    fi
    case "$action" in
      start)        if is_local; then act_start;   else act_docker_start;   fi ;;
      stop)         if is_local; then act_stop;    else act_docker_stop;    fi ;;
      restart)      if is_local; then act_restart; else act_docker_restart; fi ;;
      status)       act_status ;;
      logs)         if is_local; then act_logs;    else act_docker_logs;    fi ;;
      build)        if is_local; then die "pas de build docker en dev (utilise build-sdk)"; else act_docker_build; fi ;;
      migrate)      if is_local; then act_migrate; else act_docker_migrate; fi ;;
      seed)         if is_local; then act_seed "${1:-}"; else act_docker_seed "${1:-}"; fi ;;
      test)         act_test "$@" ;;
      build-sdk)    act_build_sdk ;;
      infra-up)     act_infra_up ;;
      infra-down)   act_infra_down ;;
      tunnels)      act_tunnels ;;
      tunnels-stop) act_tunnels_stop ;;
      email-check)  act_email_check ;;
      email-test)   act_email_test "${1:-}" ;;
      db-backup)    act_db_backup "${1:-}" ;;
      db-restore)   act_db_restore "${1:-}" ;;
      db-reset)     act_db_reset "${1:-}" ;;
      *) die "action inconnue pour $cmd — ./run.sh (sans arg) pour l'aide" ;;
    esac
    ;;
  status) cmd_status_all ;;
  *)      usage ;;
esac
