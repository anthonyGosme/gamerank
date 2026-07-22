# Email — configuration (dev & prod)

WebGameRank doit **envoyer** les magic links (critique) et **recevoir** peu
de choses (un `support@` suffit).

Le port 25 sortant du VPS IONOS a été **débloqué** (ticket support), donc un
serveur mail auto-hébergé peut désormais livrer directement. Deux voies :

```text
Voie A (auto-hébergé)  →  Poste.io : envoi + réception, tout sur le VPS
Voie B (managé)        →  Resend (envoi) + Cloudflare Email Routing (réception)
```

Le code (`mailer.ts`) est agnostique : tout se règle par variables
d'environnement. Rien à changer pour basculer dev → prod, ni A → B.

---

## 1. Dev (par défaut) — Mailpit

Aucune config : `docker compose up` lance Mailpit, qui **capture** les
emails sans les envoyer. UI : http://localhost:8025.

```bash
SMTP_HOST=localhost
SMTP_PORT=1025
# ni auth ni TLS
```

---

## 2. Voie A — Poste.io (auto-hébergé, recommandé maintenant que le 25 passe)

### a. `compose` durci
```yaml
mail:
  image: analogic/poste.io:2        # épingler la version majeure
  restart: always
  ports:
    - "25:25"      # réception + livraison sortante
    - "587:587"    # envoi authentifié (utilisé par l'app)
    - "993:993"    # IMAP
    - "127.0.0.1:8443:443"   # admin/webmail : exposé LOCALEMENT seulement
  volumes:
    - /etc/localtime:/etc/localtime:ro
    - /posteio/data:/data       # ← contient DKIM + comptes : À SAUVEGARDER
  environment:
    - HTTPS=ON
    - DOMAIN=mail.webgamerank.com   # FQDN du serveur (doit matcher le PTR)
    - TZ=Europe/Paris
  cap_add:
    - SYS_PTRACE
```
> Admin sur `127.0.0.1:8443` : accès via tunnel SSH (`ssh -L 8443:localhost:8443`),
> jamais exposé publiquement.

### b. Dans l'admin Poste.io
1. Ajouter le domaine `webgamerank.com`.
2. Créer la boîte `admin@webgamerank.com` (mot de passe fort).
3. Récupérer la clé **DKIM** générée (pour le DNS).

### c. Variables `.env` de prod (l'app parle à Poste.io en 587 authentifié)
```bash
SMTP_HOST=mail.webgamerank.com
SMTP_PORT=587
SMTP_USER=admin@webgamerank.com
SMTP_PASS=<mot de passe de la boîte>
MAIL_FROM="WebGameRank <admin@webgamerank.com>"
APP_URL=https://webgamerank.com
NODE_ENV=production
```

### d. DNS + réputation (LE point qui décide de la délivrabilité)
Une IP de VPS fraîche part avec une réputation neutre/froide. À faire :

```text
A     mail.webgamerank.com   87.106.6.144
PTR   87.106.6.144           mail.webgamerank.com   ← à poser dans le PANEL IONOS
TXT   @         "v=spf1 a mx ip4:87.106.6.144 ~all"
CNAME/TXT  <sélecteur>._domainkey   <clé DKIM fournie par Poste.io>
TXT   _dmarc    "v=DMARC1; p=none; rua=mailto:dmarc@webgamerank.com"
MX    @         mail.webgamerank.com   (priorité 10)
```

Puis **tester avant d'ouvrir aux vrais users** :
- https://mail-tester.com : envoie-lui un magic link, vise **9-10/10** ;
- vérifier que `87.106.6.144` n'est sur **aucune blocklist** (mxtoolbox →
  Blacklist Check) — fréquent sur une IP de VPS recyclée ;
- envoyer d'abord à un Gmail/Outlook perso et vérifier l'arrivée en **boîte
  de réception**, pas en spam.

> Volume faible au début = réputation qui se construit lentement mais sans
> risque de « blast ». Surveille les premières connexions.

---

## 3. Voie B — managé (Resend + Cloudflare), en secours

Si la délivrabilité Poste.io est mauvaise (IP blocklistée, spam Gmail) et que
tu ne veux pas attendre le warmup :

```bash
# envoi via Resend (gratuit 3000/mois)
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxx
MAIL_FROM="WebGameRank <admin@webgamerank.com>"
```
- Réception : Cloudflare Email Routing (catch-all → ta boîte perso), gratuit.
- DNS : SPF/DKIM/DMARC fournis par Resend ; un seul TXT SPF combinant tout.

**Hybride possible** : Poste.io pour la réception + Resend en **smarthost**
(relais sortant) — self-hosted côté boîtes, délivrabilité pro côté envoi.

---

## 4. Vérifier après déploiement

```bash
# depuis le VPS : le 25 sortant passe (déjà vérifié)
timeout 5 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25; head -1 <&3'
# bout en bout : demander un magic link, vérifier la réception + le score mail-tester
```
Logs : Poste.io a une UI de logs ; Resend a Logs → chaque envoi tracé.
