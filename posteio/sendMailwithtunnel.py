"""Test d'envoi via Poste.io — tout-en-un.

Par défaut, ouvre un tunnel SSH vers le VPS et envoie via son localhost:587
(le port n'a pas besoin d'être ouvert dans le firewall). Une seule commande :

    pip install emails sshtunnel starlette      # dépendances
    python3 posteio/sendMail.py

Le .env (à côté) doit contenir :
    EMAIL_USER=no-reply@webgamerank.com
    EMAIL_PASSWORD=...

Variables optionnelles (env) :
    USE_TUNNEL=0        → connexion DIRECTE à SMTP_HOST:SMTP_PORT (pas de tunnel)
    SMTP_HOST / SMTP_PORT   (défaut mail.webgamerank.com:587, direct)
    SSH_HOST / SSH_USER / SSH_PORT   (défaut 87.106.6.144 / root / 22)
"""
import os
import ssl
from contextlib import nullcontext

import emails
from starlette.config import Config

# Poste.io a un certif AUTO-SIGNÉ (pas de Let's Encrypt) → on ne le valide pas.
# La connexion reste chiffrée (STARTTLS).
INSECURE_CTX = ssl.create_default_context()
INSECURE_CTX.check_hostname = False
INSECURE_CTX.verify_mode = ssl.CERT_NONE


def send(host, port, user, password, recipient):
    message = emails.Message(
        subject="Test Email avec posteio",
        text="Hello World from Python avec posteio pour le webgamerank!",
        mail_from=user,
    )
    response = message.send(
        to=recipient,
        smtp={
            "host": host,
            "port": port,
            "ssl": False,
            "tls": True,
            "user": user,
            "password": password,
           # "context": INSECURE_CTX,
            "debug": 1,
        },
    )
    print(f"\nCode de réponse: {response.status_code}")
    print(f"Message du serveur: {response.error}")
    return response.status_code == 250


def main():
    config = Config('.env')
    user = config('EMAIL_USER', cast=str, default='')
    password = config('EMAIL_PASSWORD', cast=str, default='')
    recipient = "anthonygosme@gmail.com"
    if not user or not password:
        print("Erreur: EMAIL_USER / EMAIL_PASSWORD manquants dans .env")
        return

    use_tunnel = os.environ.get("USE_TUNNEL", "1") == "1"

    if use_tunnel:
        try:
            from sshtunnel import SSHTunnelForwarder
        except ImportError:
            print("Installe le tunnel : pip install sshtunnel")
            return
        ssh_host = os.environ.get("SSH_HOST", "87.106.6.144")
        ssh_user = os.environ.get("SSH_USER", "root")
        ssh_port = int(os.environ.get("SSH_PORT", "22"))
        print(f"Ouverture du tunnel SSH {ssh_user}@{ssh_host}:{ssh_port} → localhost:587 …")
        tunnel = SSHTunnelForwarder(
            (ssh_host, ssh_port),
            ssh_username=ssh_user,           # clé SSH par défaut / agent
            remote_bind_address=("127.0.0.1", 587),
        )
    else:
        tunnel = nullcontext()

    with tunnel:
        if use_tunnel:
            host, port = "127.0.0.1", tunnel.local_bind_port
        else:
            host = os.environ.get("SMTP_HOST", "mail.webgamerank.com")
            port = int(os.environ.get("SMTP_PORT", "587"))
        print(f"Envoi via {host}:{port} …")
        ok = send(host, port, user, password, recipient)

    print("\n=> ENVOYÉ ✅" if ok else "\n=> ÉCHEC ❌ (voir le message ci-dessus)")

if __name__ == "__main__":
    main()
