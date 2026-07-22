#!/usr/bin/env bash
# Exécuté sur le VPS par `./run.sh prod deploy`. Ne pas lancer sans les trois
# fichiers déposés dans /opt/webgamerank : compose, env et images.
set -euo pipefail

APP_DIR="${GR_PROD_DIR:-/opt/webgamerank}"
cd "$APP_DIR"

compose() {
  docker compose --env-file .env.prod -p webgamerank-prod -f compose.prod.yaml "$@"
}

rollback_available=false
if docker image inspect webgamerank-api:prod >/dev/null 2>&1; then
  docker tag webgamerank-api:prod webgamerank-api:rollback
  rollback_available=true
fi
if docker image inspect webgamerank-demo:prod >/dev/null 2>&1; then
  docker tag webgamerank-demo:prod webgamerank-demo:rollback
fi

rollback() {
  code=$?
  echo "Déploiement en échec (code $code)." >&2
  if [[ "$rollback_available" == true ]]; then
    echo "Retour à l'image applicative précédente..." >&2
    docker tag webgamerank-api:rollback webgamerank-api:prod
    if docker image inspect webgamerank-demo:rollback >/dev/null 2>&1; then
      docker tag webgamerank-demo:rollback webgamerank-demo:prod
    fi
    compose up -d --no-deps --force-recreate api demo-game || true
  fi
  exit "$code"
}
trap rollback ERR

docker load -i images.tar
compose config --quiet

# Les images de données sont épinglées dans le Compose. pull ne touche pas aux
# volumes et rend le premier démarrage reproductible.
compose pull postgres clickhouse
compose up -d postgres clickhouse

for _ in $(seq 1 60); do
  compose exec -T postgres pg_isready -U gamerank -d gamerank -q 2>/dev/null && break
  sleep 2
done
compose exec -T postgres pg_isready -U gamerank -d gamerank -q

mkdir -p backups
if compose exec -T postgres psql -U gamerank -d gamerank -tAc \
  "SELECT to_regclass('public.developers') IS NOT NULL" | grep -q t; then
  backup="backups/gamerank-prod-pre-deploy-$(date '+%Y%m%d-%H%M%S').sql.gz"
  compose exec -T postgres pg_dump -U gamerank -d gamerank | gzip > "$backup"
  echo "Sauvegarde pré-déploiement : $APP_DIR/$backup"
fi

# Les migrations passent avant la nouvelle API. Elles sont idempotentes et
# doivent rester rétrocompatibles avec l'image précédente pour le rollback.
compose run --rm api node dist/migrate.js
compose up -d api

for _ in $(seq 1 60); do
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:23000/health || true)" == 200 ]] && break
  sleep 2
done
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:23000/health >/dev/null
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:23000/health/ready >/dev/null

# Bootstrap assumé de la production : les 10 jeux démo fournissent le premier
# pool de jury. Jamais de re-seed automatique une fois la base non vide.
games_count="$(compose exec -T postgres psql -U gamerank -d gamerank -tAc 'SELECT count(*) FROM games' | tr -d '[:space:]')"
if [[ "${games_count:-0}" == 0 ]]; then
  echo "Base vide : bootstrap des 10 jeux de démonstration..."
  compose exec -T -e DEMO_BASE_URL=https://webgamerank.com/demo api \
    npx tsx /app/apps/api/scripts/seed-demo.ts
else
  echo "Base existante : $games_count jeux, bootstrap ignoré."
fi
compose up -d demo-game

# Smoke tests locaux. Le contrôle public via Caddy est fait par run.sh depuis
# le poste du déployeur, après le retour de cette commande.
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:23000/ >/dev/null
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:23001/demo/ >/dev/null

rm -f images.tar
trap - ERR
echo "Déploiement applicatif terminé."
