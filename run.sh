#!/usr/bin/env bash
# run.sh : point d'entrée unique de gestion pour WebGameRank.
#
# Grammaire : ./run.sh <env> <action> [args]
# Envs      : dev (local + infra docker) · homol (docker, à venir) · prod (docker, à venir)
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
  prod    stack dockerisée déployée sur le VPS derrière Caddy (à venir)

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

Commandes globales :
  status                les trois environnements d'un coup d'œil

Notes :
  - Les tunnels SSH (email + Kuma) passent par $GR_VPS (défaut root@87.106.6.144).
  - homol expose 127.0.0.1:18001 ; le reverse-proxy HTTPS est assuré par un
    Caddy local (non géré par run.sh) : voir doc/DEPLOY.md pour le bloc Caddy et
    la ligne /etc/hosts (webgamerank.hml → 127.0.0.1).
  - homol email : via le tunnel SSH (host.docker.internal:1587) → garde les
    tunnels ouverts (./run.sh dev tunnels) pour que les magic links partent.
  - prod : déploiement sur le VPS = étape suivante (compose.prod.yaml).
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
require_dev() { [[ "$ENV_KIND" == "local" ]] || die "action réservée à dev (homol/prod : à venir)"; }

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

# ─── Global ───────────────────────────────────────────────────────────────────
cmd_status_all() {
  for e in dev homol prod; do resolve_env "$e"; act_status; echo ""; done
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
