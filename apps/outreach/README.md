# Gamerank Outreach

Outils locaux de traitement des candidats collectés par l'extension Reddit.

## Interface locale

Depuis la racine du dépôt :

```bash
npm start -w apps/outreach
```
mode nav privé si KO en public
Ouvrir ensuite `http://127.0.0.1:3100`. L'interface permet de déposer un export
JSON, consulter les statuts, rechercher par jeu/auteur/domaine et voir les
e-mails dupliqués qui n'ont pas été retenus comme nouveaux contacts. Le serveur
charge `.env.dev` et propose un test SMTP de bout en bout, puis un envoi manuel
par prospect. Un prospect n'est marqué comme envoyé qu'après acceptation SMTP.

Le serveur écoute uniquement sur `127.0.0.1` : cette console n'est pas exposée
sur le réseau.

## Extraction des contacts

Dans l'interface, **Analyser tous les non analysés** traite tous les sites
candidats. L'extracteur :

- lit la page d'accueil et jusqu'à quatre pages Contact/About/Legal/Privacy du
  même site ;
- collecte uniquement les adresses publiées et les formulaires de contact ;
- utilise Chrome en mode headless seulement lorsque le HTML ressemble à une
  coquille SPA vide ;
- bloque les URL locales et les adresses réseau privées ;
- n'invente jamais d'adresse et n'envoie aucun message sans clic explicite ;
- conserve la page source, les doublons et les erreurs dans SQLite ;
- extrait le titre depuis le champ `Game Title:` du modèle Reddit ;
- classe CrazyGames comme plateforme, jamais comme site autonome ;
- affiche le lien de la page Contact lorsqu'elle a été trouvée.

La même opération peut être lancée sans interface :

```bash
npm run analyze:sites -w apps/outreach
```

## Import SQLite

Depuis la racine du dépôt :

```bash
npm run import:candidates -w apps/outreach -- "/chemin/vers/candidates.json"
```

La base est créée dans `data/outreach.sqlite`. Un second chemin peut être passé
après le fichier JSON pour choisir une autre base.

L'import est idempotent : réimporter exactement le même fichier ne crée pas de
doublons. Les prospects commencent avec l'un de ces états :

- `site_found` : au moins un site autonome candidat ;
- `platform_only` : uniquement une plateforme de jeu ou un store ;
- `needs_review` : aucun site exploitable détecté.

La base locale et ses fichiers WAL sont ignorés par Git.
