#!/usr/bin/env bash
# Déploiement Poste.io pour WebGameRank — À LANCER SUR LE VPS (root).
#
#   scp infra/posteio/deploy.sh root@87.106.6.144:/root/
#   ssh root@87.106.6.144 'bash /root/deploy.sh'
#
# Idempotent : écrit le compose, (re)lance le conteneur, ne touche pas au /data
# existant. Les étapes non scriptables (admin UI, PTR, DNS) sont listées à la fin.
set -euo pipefail

MAIL_FQDN="mail.webgamerank.com"
DIR="/posteio"

echo "==> 1/4  Vérification du port 25 sortant"
if timeout 5 bash -c "exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25" 2>/dev/null; then
  echo "    OK : le 25 sortant passe."
else
  echo "    ⚠ 25 sortant BLOQUÉ — Poste.io ne pourra pas livrer. Débloque chez IONOS d'abord."
fi

echo "==> 2/4  Écriture de $DIR/docker-compose.yml"
mkdir -p "$DIR/data"
cat > "$DIR/docker-compose.yml" <<YAML
services:
  mail:
    image: analogic/poste.io:2
    restart: always
    ports:
      # pas de 80 (serveur web déjà dessus) → certif auto-signé, cf DEPLOY-LOG
      - "25:25"
      - "587:587"
      - "993:993"
      - "127.0.0.1:8443:443"
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - $DIR/data:/data
    environment:
      - HTTPS=ON
      - DOMAIN=$MAIL_FQDN
      - TZ=Europe/Paris
    cap_add:
      - SYS_PTRACE
YAML

echo "==> 3/4  Pull + démarrage"
cd "$DIR"
docker compose pull
docker compose up -d

echo "==> 4/4  Attente du démarrage"
sleep 8
docker compose ps

cat <<'NEXT'

===========================================================================
 Conteneur lancé. Actions MANUELLES restantes (non scriptables) :

 A. ADMIN POSTE.IO  — depuis TA machine, ouvre un tunnel SSH puis le navigateur :
      ssh -L 8443:localhost:8443 root@87.106.6.144
      → https://localhost:8443  (crée le compte admin au 1er accès)
      1. Add domain: webgamerank.com
      2. Create mailbox: no-reply@webgamerank.com  (mot de passe fort)
      3. Copie la clé DKIM générée (Settings → DKIM)

 B. PANEL IONOS  — reverse DNS (PTR) :
      87.106.6.144  →  mail.webgamerank.com

 C. DNS de webgamerank.com  (registrar / Cloudflare) :
      A     mail        87.106.6.144
      TXT   @           "v=spf1 a mx ip4:87.106.6.144 ~all"
      <sel>._domainkey  <clé DKIM copiée en A.3>
      TXT   _dmarc      "v=DMARC1; p=none; rua=mailto:dmarc@webgamerank.com"
      MX    @           mail.webgamerank.com   (priorité 10)

 D. AVANT d'ouvrir : mail-tester.com (vise 9-10/10) + blacklist check de l'IP.
===========================================================================
NEXT
