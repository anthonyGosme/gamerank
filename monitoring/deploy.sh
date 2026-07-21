#!/usr/bin/env bash
# Déploiement Uptime Kuma pour WebGameRank — À LANCER SUR LE VPS (root).
#
#   scp monitoring/deploy.sh root@87.106.6.144:/root/
#   ssh root@87.106.6.144 'bash /root/deploy.sh'
#
# Idempotent : écrit le compose, (re)lance le conteneur, ne touche pas au /data
# existant (config + historique Kuma). Le dashboard n'écoute qu'en local
# (127.0.0.1:3001) : accès par tunnel SSH. Étapes manuelles listées à la fin.
set -euo pipefail

DIR="/monitoring"

echo "==> 1/3  Écriture de $DIR/docker-compose.yml"
mkdir -p "$DIR/data"
cat > "$DIR/docker-compose.yml" <<YAML
services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    container_name: uptime-kuma
    restart: unless-stopped
    network_mode: host                 # accès aux services 127.0.0.1 de l'hôte
    environment:
      - UPTIME_KUMA_HOST=127.0.0.1     # écoute loopback uniquement (pas exposé)
      - UPTIME_KUMA_PORT=3001
    volumes:
      - $DIR/data:/app/data            # config + historique — À SAUVEGARDER
      - /var/run/docker.sock:/var/run/docker.sock:ro
YAML

echo "==> 2/3  Pull + démarrage"
cd "$DIR"
docker compose pull
docker compose up -d

echo "==> 3/3  Attente du démarrage"
sleep 5
docker compose ps

cat <<'NEXT'

===========================================================================
 Uptime Kuma lancé. Actions MANUELLES restantes (non scriptables) :

 A. DASHBOARD — depuis TA machine, ouvre le tunnel puis le navigateur :
      ./posteio/startsshtunnelfordev.sh          (inclut déjà -L 3001)
      → http://localhost:3001  (crée le compte admin au 1er accès)

 B. ALERTES NTFY — Settings → Notifications → ntfy
      Server https://ntfy.sh + un Topic secret (long, imprévisible).
      Installe l'appli ntfy sur le tél et abonne-toi au même topic.
      Cf. doc/MONITORING.md §2b.

 C. MONITEURS — les créer selon le tableau doc/MONITORING.md §2d.
      host mode → viser les services par localhost:<port> :
        - webmail Poste.io : https://localhost:8443  (Ignore TLS: ON)
        - SMTP : localhost:587 et localhost:25  (TCP Port)
        - conteneur posteio-mail-1  (Docker)
      Pour les moniteurs Docker : Settings → Docker Hosts →
      unix:///var/run/docker.sock
      Intervalle : 30 min.
===========================================================================
NEXT
