# posteio/ — outils dev pour le serveur mail

Le serveur mail (Poste.io) tourne sur le VPS. Rien n'est exposé publiquement
à part le port 25 : le **webmail/admin** et le **port d'envoi 587** ne sont
joignables qu'en `localhost` du serveur. On y accède depuis le Mac via des
**tunnels SSH**.

> Config & déploiement du serveur : voir [`../infra/posteio/`](../infra/posteio/).
> Ne mets JAMAIS de vrai mot de passe ici — il vit dans `.env` (gitignoré).

## Contenu

| Fichier | Rôle |
|---|---|
| `startsshtunnelfordev.sh` | ouvre les 2 tunnels SSH (webmail + envoi) |
| `sendMailwithtunnel.py` | test d'envoi (tunnel intégré, ou via un tunnel déjà ouvert) |

## Pré-requis
- Accès SSH au VPS (`ssh root@87.106.6.144` doit marcher, clé déjà en place).
- Pour `sendMailwithtunnel.py` : `python3 -m pip install --user emails sshtunnel starlette`
- Un `.env` **dans ce dossier** (gitignoré) avec :
  ```bash
  EMAIL_USER=no-reply@webgamerank.com
  EMAIL_PASSWORD=<mot de passe de la boîte>
  ```

## 1. Lancer les tunnels

```bash
./posteio/startsshtunnelfordev.sh
```
Laisse ce terminal ouvert (`Ctrl+C` pour fermer). Il ouvre :
- **Webmail / admin** → `https://localhost:8443`
- **Envoi SMTP** → `localhost:1587` (→ le 587 du serveur)

## 2. Ouvrir le webmail / l'admin

Tunnels lancés, ouvre dans le navigateur :
```
https://localhost:8443
```
> Avertissement de certificat = normal (certif auto-signé). Accepte l'exception.

## 3. Pointer ton code vers le tunnel (dev local)

Pour envoyer de **vrais** emails depuis l'app en dev (au lieu de Mailpit),
pointe le `.env` de l'app sur le tunnel :

```bash
SMTP_HOST=localhost
SMTP_PORT=1587
SMTP_USER=no-reply@webgamerank.com
SMTP_PASS=<mot de passe de la boîte>
SMTP_TLS_INSECURE=true          # certif auto-signé
MAIL_FROM="WebGameRank <no-reply@webgamerank.com>"
```

> `hostname = localhost`, `port = 1587` : entrée locale du tunnel, qui ressort
> sur le `587` du serveur. `SMTP_TLS_INSECURE=true` car le certif est émis pour
> `mail.webgamerank.com`, pas `localhost`.

En **prod**, l'app tourne sur le même VPS que Poste.io : plus de tunnel,
`SMTP_HOST=mail.webgamerank.com` en direct (voir `infra/posteio/`).

## Test rapide d'envoi

```bash
# via le tunnel déjà ouvert (script du point 1) :
USE_TUNNEL=0 SMTP_HOST=localhost SMTP_PORT=1587 python3 posteio/sendMailwithtunnel.py

# ou tunnel intégré (ouvre/ferme tout seul, pas besoin du point 1) :
python3 posteio/sendMailwithtunnel.py
```
Attendu : dialogue SMTP, `Code de réponse: 250`, `=> ENVOYÉ ✅`, mail reçu.
