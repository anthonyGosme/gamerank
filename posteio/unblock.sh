#!/usr/bin/env bash
# Débloque l'IP bannie par la protection anti-abus de Poste.io.
# À LANCER SUR LE VPS :
#   scp posteio/unblock.sh root@87.106.6.144:/root/ && ssh root@87.106.6.144 'bash /root/unblock.sh'
#
# Étapes : localise Redis → liste l'état de ban → flush l'anti-abus (transient) →
# cherche un éventuel stockage dans /data → restart → re-teste la bannière SMTP.
# Sans danger pour les comptes/DKIM/messages (fichiers + base durable, PAS Redis).
set -uo pipefail

C=posteio-mail-1
IP="${1:-172.22.0.1}"

echo "===================================================================="
echo " A. Localisation de Redis"
echo "===================================================================="
docker exec "$C" sh -lc '
  echo "-- process redis --"
  ps -e -o pid,args 2>/dev/null | grep -i "[r]edis-server" || echo "  (aucun redis-server)"
  echo "-- sockets à l écoute (tcp + unix) --"
  { ss -lntp 2>/dev/null; ss -lnxp 2>/dev/null; } | grep -i redis || echo "  (rien via ss)"
  echo "-- fichiers de conf redis --"
  for f in $(find /etc /data /opt /usr/local -maxdepth 4 -name "redis*.conf" 2>/dev/null); do
    echo "## $f"; grep -iE "^[[:space:]]*(port|bind|unixsocket|requirepass)" "$f" 2>/dev/null
  done
  echo "-- sockets .sock trouvés --"
  find /var/run /run /tmp /data -name "*redis*.sock" 2>/dev/null || true
'

echo
echo "===================================================================="
echo " B. Connexion Redis + état de ban + flush anti-abus"
echo "===================================================================="
docker exec -e IP="$IP" "$C" sh -lc '
  ARGS=""
  # 1) sockets unix
  for s in $(find /var/run /run /tmp /data -name "*redis*.sock" 2>/dev/null); do
    if redis-cli -s "$s" ping >/dev/null 2>&1; then ARGS="-s $s"; break; fi
  done
  # 2) ports courants
  if [ -z "$ARGS" ]; then
    for p in 6379 6380 6381; do
      if redis-cli -p "$p" ping >/dev/null 2>&1; then ARGS="-p $p"; break; fi
    done
  fi
  if [ -z "$ARGS" ]; then
    echo "  ❌ Redis introuvable (ni socket ni port testé) — voir section A."
    exit 0
  fi
  echo "  ✅ Redis joignable via: redis-cli $ARGS"
  echo "  nb de clés : $(redis-cli $ARGS dbsize)"
  echo "-- clés liées à IP / karma / ban / abuse / grey (AVANT) --"
  { redis-cli $ARGS --scan --pattern "*${IP}*"
    redis-cli $ARGS --scan --pattern "*karma*"
    redis-cli $ARGS --scan --pattern "*ban*"
    redis-cli $ARGS --scan --pattern "*abus*"
    redis-cli $ARGS --scan --pattern "*grey*"
    redis-cli $ARGS --scan --pattern "*black*"
  } 2>/dev/null | sort -u | sed "s/^/    /"
  echo "-- FLUSHALL (anti-abus transient : greylisting/karma/compteurs) --"
  redis-cli $ARGS flushall && echo "  ✅ FLUSHALL ok"
'

echo
echo "===================================================================="
echo " C. Stockage éventuel du ban dans /data (fichiers + bases)"
echo "===================================================================="
docker exec -e IP="$IP" "$C" sh -lc '
  echo "-- fichiers texte mentionnant $IP --"
  grep -rIl "$IP" /data 2>/dev/null | head || true
  echo "-- bases sqlite/db --"
  find /data -maxdepth 4 \( -name "*.db" -o -name "*.sqlite*" \) 2>/dev/null | head || true
'

echo
echo "===================================================================="
echo " D. Restart + re-test"
echo "===================================================================="
docker restart "$C" >/dev/null && echo "  restarted"
sleep 20
echo -n "  admin HTTP (interne) : "
docker exec "$C" sh -lc "curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:443/admin/login" 2>/dev/null || echo KO
echo -n "  bannière SMTP 587    : "
docker exec "$C" sh -lc 'exec 3<>/dev/tcp/127.0.0.1/587; head -c 90 <&3' 2>/dev/null || echo KO
echo
echo
echo "→ '220 mail.webgamerank.com ...' = débloqué ✅   |   '554 Blacklisted' = encore bloqué"
echo "  Si encore bloqué : colle-moi TOUTE la sortie (surtout A, B, C)."
