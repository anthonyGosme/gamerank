# Checklist de mise en production — WebGameRank

**Date :** à renseigner · **Déployeur :** à renseigner

## Avant le premier déploiement

- [ ] `npm test` passe avec PostgreSQL et ClickHouse locaux.
- [ ] `./run.sh homol start` puis la recette critique passent en HTTPS.
- [ ] `./run.sh prod init` a créé `.env.prod` avec les permissions `600`.
- [ ] `.env.prod` ne contient plus `CHANGE_ME` ni `example.com`.
- [ ] Les mots de passe PostgreSQL, ClickHouse, SMTP et le tripwire sont uniques.
- [ ] Le DNS de `webgamerank.com` pointe vers le VPS.
- [ ] Le réseau `PROD_PROXY_NETWORK` existe et contient le Caddy.
- [ ] Le bloc Caddy `/demo/*` puis API est chargé sans erreur.
- [ ] Poste.io accepte l'authentification SMTP depuis le conteneur.
- [ ] SPF, DKIM, DMARC et PTR sont validés.
- [ ] L'espace disque couvre images, bases et sauvegarde pré-déploiement.
- [ ] Une destination de sauvegarde hors VPS est définie.

## Déploiement

- [ ] Lancer `./run.sh prod deploy`.
- [ ] Confirmer la création du dump pré-déploiement si la base existait.
- [ ] Confirmer `./run.sh prod status` : quatre services actifs.
- [ ] Vérifier `https://webgamerank.com/health` et la page d'accueil.
- [ ] Vérifier `https://webgamerank.com/demo/` et ouvrir un jeu.
- [ ] Demander un magic link réel et vérifier sa réception.
- [ ] Vérifier `/health/ready` et `/health/email` via Kuma, côté VPS.
- [ ] Sur une base neuve, confirmer la présence des 10 jeux et du pool de jury.

## Après déploiement

- [ ] Effectuer une inscription et une connexion complètes.
- [ ] Vérifier qu'un jeu démo émet des événements et permet de voter.
- [ ] Vérifier qu'une passe de scoring termine avec le statut `ok`.
- [ ] Surveiller logs, disponibilité, SMTP et espace disque pendant 15 minutes.
- [ ] Configurer les moniteurs Kuma décrits dans `MONITORING.md`.
- [ ] Copier et tester la restauration d'une sauvegarde hors VPS.

## Déclencheurs de rollback

- `/health` ou `/health/ready` reste en erreur après le déploiement.
- La home, l'authentification ou les magic links ne fonctionnent plus.
- Les migrations échouent ou l'API redémarre en boucle.
- L'ingestion ou le scoring produit des erreurs répétées.
- Le taux d'erreurs HTTP 5xx dépasse 1 % pendant 5 minutes.

Le script restaure automatiquement l'image précédente en cas d'échec pendant
le déploiement. Après une réussite, un rollback manuel consiste à retaguer
`webgamerank-api:rollback` et `webgamerank-demo:rollback`, puis à recréer les
deux services. Examiner d'abord la compatibilité des migrations déjà jouées.
