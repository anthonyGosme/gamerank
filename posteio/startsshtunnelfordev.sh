#!/usr/bin/env bash
# Ouvre 2 tunnels SSH depuis le Mac vers le VPS Poste.io (dev).
# Rien n'est exposé côté firewall : tout passe par le localhost du serveur.
#
#   ./posteio/startsshtunnelfordev.sh      (laisser tourner, Ctrl+C pour fermer)
#
# Tunnels :
#   • Webmail / admin Poste.io  : https://localhost:8443
#       (le serveur écoute l'admin sur 127.0.0.1:8443 — compose)
#   • Envoi SMTP (submission)    : localhost:1587  →  587 du serveur
#       pour tester l'envoi :
#         USE_TUNNEL=0 SMTP_HOST=localhost SMTP_PORT=1587 python3 posteio/sendMail.py
set -euo pipefail

VPS="${VPS:-root@87.106.6.144}"

echo "Tunnels SSH ouverts vers $VPS :"
echo "  • Webmail / admin : https://localhost:8443"
echo "  • Envoi SMTP      : localhost:1587"
echo
echo "Laisse ce terminal ouvert. Ctrl+C pour fermer les tunnels."
echo

# -N : pas de shell distant, juste les tunnels. exec : Ctrl+C ferme proprement.
exec ssh -N \
  -o ServerAliveInterval=30 \
  -L 8443:localhost:8443 \
  -L 1587:localhost:587 \
  "$VPS"
