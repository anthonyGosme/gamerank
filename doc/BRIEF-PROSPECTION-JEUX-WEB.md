# Brief d'architecture — prospection de développeurs de jeux web

## Objet du document

Ce document décrit un besoin encore ouvert afin de recueillir et comparer des
propositions d'architecture de plusieurs LLM ou experts.

Il ne constitue pas une décision d'architecture. Les technologies citées sont
des pistes à évaluer, pas des choix imposés.

## Résumé

WebGameRank souhaite inviter des développeurs de jeux web à inscrire leur jeu
sur la plateforme.

Une source intéressante est le subreddit `r/playmygame`, notamment les
publications ayant le flair `[PC] (Web)`. Le volume envisagé est faible :
quelques nouvelles publications à examiner chaque jour.

Le travail manuel actuellement envisagé serait :

1. consulter régulièrement la liste filtrée des publications ;
2. ouvrir chaque publication pertinente ;
3. retrouver le lien vers le jeu ou son site officiel ;
4. déterminer si le jeu est publié sur une plateforme tierce ou sur un domaine
   contrôlé par son développeur ;
5. parcourir le site du jeu afin de trouver un contact public ;
6. qualifier ce contact ;
7. préparer puis envoyer une invitation personnalisée ;
8. enregistrer que ce jeu ou ce contact a déjà été traité.

La partie la plus coûteuse et incertaine est l'extraction : navigation dans
Reddit, identification du bon lien externe, analyse de sites très différents,
prise en charge des SPA, découverte d'une adresse de contact et conservation
des preuves ayant mené au résultat.

L'objectif est donc d'automatiser ou de semi-automatiser ce processus quotidien
sans construire un système lourd par rapport au faible volume.

## Contexte existant

WebGameRank est principalement une application TypeScript :

- API Fastify rendue côté serveur ;
- PostgreSQL pour les données applicatives ;
- ClickHouse pour les événements de jeu ;
- Nodemailer et SMTP pour les e-mails existants ;
- pages d'administration déjà présentes ;
- déploiement Docker ;
- mécanismes existants de validation d'URL et de protection SSRF à examiner
  avant d'ajouter un nouveau crawler.

Une page `/contact` et un transport SMTP existent déjà, mais les e-mails de
prospection ne devraient pas nécessairement partager l'expéditeur ou la
réputation des e-mails fonctionnels, notamment les liens de connexion.

## Résultat recherché

À terme, l'opérateur devrait disposer chaque jour d'une petite file de
candidats qualifiés :

```text
Publication détectée
        ↓
Lien du jeu identifié
        ↓
Site et hébergement qualifiés
        ↓
Contact public trouvé avec sa source
        ↓
Message proposé
        ↓
Validation humaine
        ↓
Envoi et historisation
```

Le système doit réduire fortement le temps de recherche tout en laissant à
l'humain la décision finale d'envoyer un message, au moins dans une première
version.

## Périmètre fonctionnel

### 1. Acquisition des publications

Source initiale :

- `https://www.reddit.com/r/playmygame/`
- filtre recherché : flair `[PC] (Web)`.

Contrainte exprimée : il n'est pas prévu de demander une autorisation
spécifique à Reddit.

Le faible volume conduit à envisager notamment :

- une navigation manuelle assistée ;
- un navigateur déjà connecté, contrôlé à la demande ;
- une extension ou un bookmarklet important les publications visibles ;
- une automatisation Playwright avec profil persistant ;
- toute autre approche limitant la collecte au strict nécessaire.

La proposition d'architecture doit expliquer explicitement ce qui est manuel,
assisté ou autonome. Elle doit aussi exposer les conséquences opérationnelles
et les risques d'un accès automatisé sans approbation, sans proposer de
contournement des protections ou de dissimulation de l'automatisation.

### 2. Extraction du lien du jeu

Pour chaque publication retenue, le système doit essayer d'identifier :

- le lien jouable ;
- le site officiel du jeu ;
- éventuellement le site du studio ou du développeur ;
- les redirections intermédiaires ;
- la publication source et son identifiant, pour la déduplication.

Une publication peut contenir plusieurs liens. Il faut donc distinguer un lien
vers le jeu d'un lien vers une vidéo, une image, Discord, Steam, Patreon ou un
réseau social.

Le résultat doit comporter un niveau de confiance et les éléments ayant motivé
la décision.

### 3. Qualification du mode de publication

Le besoin initial distingue :

- jeu publié sur une plateforme tierce ;
- jeu « auto-hébergé » ou publié sur un site appartenant au développeur.

Cette distinction est ambiguë et doit être précisée par l'architecture. Par
exemple, un domaine personnalisé servi par Vercel, Netlify ou Cloudflare Pages
est techniquement hébergé par une plateforme, mais reste contrôlé par le
développeur.

Une taxonomie possible, non imposée, serait :

- `platform_profile` : page sous le domaine d'une plateforme de jeux ;
- `owner_domain` : domaine propre contrôlé par le développeur ;
- `custom_domain_hosted` : domaine propre servi par un hébergeur managé ;
- `unknown`.

La proposition doit expliquer les signaux utilisés : URL finale, domaine,
DNS/CNAME, métadonnées, signatures HTML, liens sortants ou autres.

### 4. Analyse du site externe

Pour les sites jugés pertinents, le système doit parcourir un nombre réduit de
pages publiques, par exemple :

- accueil ;
- contact ;
- about/team ;
- mentions légales ou impressum ;
- politique de confidentialité.

Il doit rechercher :

- liens `mailto:`;
- adresses électroniques réellement affichées ;
- adresse générique de société ou de studio ;
- formulaire de contact, même si aucune adresse n'est publiée ;
- identité du studio ou du développeur ;
- URL exacte où chaque information a été trouvée.

Il ne doit pas inventer une adresse à partir d'un nom ou d'un domaine.

Les sites rencontrés peuvent être :

- HTML statique ;
- rendus côté serveur ;
- SPA nécessitant JavaScript ;
- protégés par une bannière de cookies ;
- lents, indisponibles ou mal formés ;
- redirigés vers une autre origine ;
- servis par une plateforme connue.

### 5. Qualification du contact

Le système doit au minimum distinguer :

- adresse générique professionnelle, par exemple `contact@studio.example` ;
- adresse nominative professionnelle ;
- adresse vraisemblablement personnelle ;
- formulaire sans adresse visible ;
- aucun contact trouvé ;
- cas incertain nécessitant une revue.

Le résultat doit conserver :

- l'adresse ou le formulaire ;
- la page source ;
- la date de découverte ;
- la catégorie estimée ;
- le niveau de confiance ;
- les éventuels motifs d'exclusion.

### 6. Revue et décision humaine

Une interface d'administration doit permettre de :

- voir les nouveaux candidats ;
- ouvrir la publication et le site source ;
- comprendre comment le système est arrivé à ses conclusions ;
- corriger le jeu, le domaine, la classification ou le contact ;
- prévisualiser et modifier le message ;
- approuver l'envoi ;
- ignorer définitivement ou temporairement un candidat ;
- inscrire un domaine ou une adresse sur une liste d'opposition.

### 7. Envoi et suivi

Le système doit :

- personnaliser le message avec le nom du jeu et sa source ;
- n'envoyer qu'après validation humaine dans le MVP ;
- éviter les doublons par publication, domaine, jeu et adresse ;
- enregistrer la date, le destinataire et la version du message ;
- gérer au minimum les statuts envoyé, échec, rebond et opposition ;
- empêcher tout nouvel envoi vers une adresse ou un domaine opposé ;
- conserver un moyen simple de répondre ou de refuser tout autre message.

La proposition doit discuter de la séparation entre :

- SMTP fonctionnel de WebGameRank, utilisé notamment pour l'authentification ;
- SMTP ou sous-domaine consacré aux invitations.

## Difficultés principales

### Sites dynamiques

Une extraction HTTP classique est rapide et peu coûteuse, mais ne voit pas
nécessairement le contenu produit par JavaScript.

Trafilatura est envisagé pour extraire du texte depuis du HTML, mais :

- il n'exécute pas JavaScript ;
- il n'est pas un moteur de navigation ;
- il peut recevoir le HTML rendu par un navigateur ;
- son intérêt pour extraire des liens et des adresses structurées doit être
  comparé à un parseur DOM.

Playwright est envisagé pour les SPA, mais :

- il est plus lent et plus consommateur de ressources ;
- les sessions et sélecteurs peuvent devenir fragiles ;
- les cookies, CAPTCHA et changements d'interface compliquent l'autonomie ;
- son usage systématique pourrait être disproportionné au volume.

Une architecture en deux passes — HTTP/DOM d'abord, navigateur en fallback —
semble plausible mais doit être challengée.

### Détermination du « bon » site

Le premier lien externe n'est pas nécessairement le jeu. L'analyse doit
éviter de confondre :

- trailer YouTube ;
- page Steam ;
- dépôt GitHub ;
- profil social ;
- serveur Discord ;
- page de financement ;
- page officielle ou jeu réellement jouable.

### Extraction fiable d'un contact

Les e-mails peuvent se trouver dans le DOM, dans du texte, derrière un lien,
sur une page secondaire ou ne pas exister. Les adresses peuvent aussi appartenir
à la plateforme d'hébergement plutôt qu'au développeur.

L'architecture doit définir la part respective :

- des règles déterministes ;
- d'une base de signatures de plateformes ;
- d'un navigateur ;
- d'un LLM ou d'un modèle local ;
- de la revue humaine.

### Sécurité

Le système suivra des URL fournies par des tiers. Il doit donc traiter
explicitement :

- SSRF et rebinding DNS ;
- accès aux réseaux privés et métadonnées cloud ;
- redirections vers des adresses interdites ;
- protocoles non HTTP ;
- taille et durée des téléchargements ;
- nombre de pages et profondeur de crawl ;
- contenu malveillant ;
- exécution de JavaScript dans un navigateur isolé ;
- téléchargements et ouverture de fichiers ;
- stockage des cookies d'un navigateur connecté.

### Conformité et réputation

Les publications et adresses publiques ne sont pas automatiquement libres de
toute contrainte de réutilisation. La solution doit prévoir :

- collecte minimale ;
- conservation de la provenance ;
- durée de conservation ;
- information du destinataire sur l'origine du contact ;
- droit d'opposition simple ;
- liste d'opposition durable ;
- traitement distinct des adresses professionnelles et personnelles ;
- absence de relance automatique dans le MVP ;
- faible cadence d'envoi ;
- protection de la réputation des e-mails fonctionnels.

Références à prendre en compte :

- Reddit Responsible Builder Policy :
  <https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy>
- Reddit Developer Terms :
  <https://redditinc.com/policies/developer-terms>
- CNIL — communications électroniques :
  <https://www.cnil.fr/fr/communication-electronique-quelles-regles>
- CNIL — réutilisation de données publiées sur Internet :
  <https://www.cnil.fr/sites/default/files/2024-06/recommandations_reutilisateurs_donnees_publiees_sur_internet.pdf>

## Contraintes non fonctionnelles

- Volume initial : quelques publications et sites par jour.
- Coût d'exploitation faible.
- Exécution quotidienne ou déclenchée manuellement.
- Idempotence et reprise après erreur.
- Traçabilité de chaque décision automatique.
- Explicabilité suffisante pour une validation rapide.
- Limitation stricte du nombre de pages visitées.
- Tolérance aux sites indisponibles.
- Pas de dépendance obligatoire à un LLM pour les cas simples.
- Possibilité de remplacer un extracteur sans réécrire tout le workflow.
- Tests réalisables sans interroger Reddit ni envoyer de véritables e-mails.
- Conservation de fixtures HTML représentant des sites statiques et des SPA.

## États métier à prévoir

La nomenclature exacte reste à définir, mais le workflow doit pouvoir
représenter au minimum :

```text
discovered
extracting
needs_review
platform_hosted
no_game_url
no_contact
contact_found
approved
rejected
sent
send_failed
bounced
opted_out
```

Il faut déterminer si l'état appartient à une publication, un jeu, un domaine,
un contact ou une tentative d'envoi. Un seul champ de statut global risque de
devenir insuffisant.

## Hors périmètre du MVP

- envoi massif ;
- séquences automatiques de relance ;
- génération ou supposition d'adresses électroniques ;
- achat de fichiers de prospects ;
- messages privés Reddit automatisés ;
- contournement de CAPTCHA, blocages ou limites techniques ;
- analyse exhaustive d'un domaine ;
- crawling généraliste du Web ;
- scoring comportemental détaillé des personnes ;
- inscription automatique d'un jeu sans action du développeur.

## Décisions d'architecture attendues

La proposition doit répondre aux questions suivantes.

### Acquisition

1. Quel niveau d'automatisation Reddit recommander compte tenu des contraintes ?
2. Une extension de navigateur ou un bookmarklet est-il préférable à un profil
   Playwright persistant ?
3. Comment rendre l'import robuste aux changements du DOM Reddit ?
4. Quelle partie peut rester manuelle sans recréer le coût initial ?

### Extraction

5. Quelle stratégie à plusieurs niveaux employer pour HTML statique et SPA ?
6. Dans quels cas précis déclencher Playwright ?
7. Trafilatura apporte-t-il une valeur réelle dans ce cas d'usage ?
8. Faut-il rester entièrement en TypeScript ou ajouter un worker Python ?
9. Comment limiter les faux positifs lors du choix du lien officiel ?
10. Comment détecter les plateformes et domaines contrôlés par les développeurs ?

### IA

11. Quels traitements doivent être déterministes ?
12. Quels traitements bénéficient réellement d'un LLM ?
13. Quel schéma structuré imposer aux sorties du LLM ?
14. Comment évaluer la confiance et déclencher une revue humaine ?
15. Comment éviter d'envoyer à un LLM plus de contenu ou de données que
    nécessaire ?

### Données et workflow

16. Quel modèle PostgreSQL proposer pour les publications, jeux, domaines,
    contacts, preuves, décisions, envois et oppositions ?
17. Comment assurer la déduplication et l'idempotence ?
18. Quelle machine à états ou quel système de jobs utiliser ?
19. Comment permettre la reprise après une extraction interrompue ?

### Exploitation

20. Cron, worker intégré, file de jobs ou service séparé ?
21. Comment isoler Playwright et ses ressources ?
22. Quels logs, métriques et alertes sont nécessaires à ce faible volume ?
23. Comment tester l'ensemble avec des fixtures reproductibles ?
24. Quel mécanisme d'envoi protège le mieux la réputation du domaine principal ?

## Format demandé aux LLM consultés

Merci de produire une réponse contenant :

1. les hypothèses retenues ;
2. deux ou trois architectures possibles ;
3. un tableau comparatif coûts, complexité, fiabilité et maintenance ;
4. l'architecture recommandée et les raisons du choix ;
5. un diagramme du flux ;
6. les composants et frontières de sécurité ;
7. un modèle de données proposé ;
8. la stratégie d'extraction statique/SPA ;
9. la place exacte de l'IA ;
10. le workflow de validation et d'envoi ;
11. les principaux risques et mesures de réduction ;
12. un plan MVP découpé en étapes ;
13. une estimation qualitative de l'effort ;
14. les questions qui doivent encore être tranchées par le porteur du projet.

La réponse ne doit pas supposer que l'automatisation totale est forcément
préférable. Elle doit optimiser le temps humain total pour un volume de
quelques candidats par jour.

## Version courte à copier dans un autre LLM

> Je conçois pour WebGameRank un outil semi-automatique de prospection de
> développeurs de jeux web. La source initiale est le subreddit
> `r/playmygame`, filtré par le flair `[PC] (Web)`, avec seulement quelques
> nouvelles publications par jour. Le travail coûteux est d'ouvrir les posts,
> identifier le vrai lien du jeu, distinguer plateforme tierce et domaine
> contrôlé par le développeur, parcourir des sites statiques ou SPA, trouver un
> contact public avec sa page source, qualifier ce contact, dédupliquer puis
> préparer un e-mail. L'envoi doit rester validé humainement dans le MVP.
>
> Le projet existant est en TypeScript/Fastify/PostgreSQL/Docker. Nodemailer
> existe déjà pour les e-mails fonctionnels. Les pistes envisagées incluent
> extension navigateur ou navigateur connecté pour l'acquisition, extraction
> HTTP/DOM, Trafilatura, Playwright en fallback et LLM seulement pour les cas
> ambigus. Il n'est pas prévu de demander une autorisation spécifique à
> Reddit ; l'architecture doit donc exposer honnêtement les limites et risques,
> sans proposer de contourner des protections.
>
> Propose deux ou trois architectures, compare-les, recommande un MVP et
> détaille : flux, composants, sécurité SSRF/navigation, modèle PostgreSQL,
> déduplication, machine à états, stratégie statique/SPA, rôle exact du LLM,
> interface de revue, séparation des e-mails promotionnels et fonctionnels,
> tests, exploitation quotidienne, risques et effort.
