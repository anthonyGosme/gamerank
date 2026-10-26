# Comparatif des architectures de prospection

**Statut :** proposition pour décision  
**Date :** 24 juillet 2026  
**Décideur :** porteur de WebGameRank  
**Document source :** [brief du besoin](./BRIEF-PROSPECTION-JEUX-WEB.md)

## Décision à prendre

Choisir l'architecture d'un outil à faible volume qui :

- acquiert quelques candidats par jour depuis `r/playmygame` ;
- retrouve le site officiel et un contact public ;
- fonctionne avec des sites statiques et des SPA ;
- conserve les preuves et évite les doublons ;
- prépare un e-mail soumis à validation humaine ;
- ne demande pas d'autorisation spécifique à Reddit ;
- limite le temps humain, les risques de blocage et la maintenance.

Le coût principal à réduire est l'analyse des publications et des sites, pas
l'envoi des e-mails.

## Propositions comparées

Les deux analyses externes proposent chacune plusieurs variantes. Pour rendre
le choix lisible, la matrice principale compare leur recommandation finale,
la recommandation Codex précédente et une nouvelle synthèse.

### P1 — LLM 1 : collecte Reddit JSON/RSS entièrement automatique

- Cron serveur toutes les six heures.
- Lecture de Reddit par endpoint `.json` ou RSS.
- Worker Node + Trafilatura + Playwright en fallback.
- LLM pour les cas ambigus.
- Interface de revue et envoi humainement validé.
- Estimation annoncée : 10 à 12 jours.

### P2 — LLM 2 : extension navigateur + backend d'enrichissement

- Extension Manifest V3 dans le navigateur connecté.
- Import des publications visibles dans Fastify.
- Backend `fetch`/DOM + Trafilatura + Playwright en fallback.
- LLM en dernier recours.
- Interface de revue et envoi humainement validé.
- Estimation annoncée : environ trois semaines.

### P3 — Codex initial : extension légère + pipeline TypeScript

- Extension ou action explicite dans le navigateur pour l'acquisition.
- Backend TypeScript `fetch` + parseur DOM.
- Playwright seulement pour les sites nécessitant réellement JavaScript.
- Pas de worker Python/Trafilatura sans bénéfice préalablement mesuré.
- LLM uniquement pour choisir ou qualifier des candidats déjà extraits.
- Interface Fastify rendue côté serveur.

### P4 — Nouvelle synthèse : MVP progressif centré sur l'extracteur

- Première version : saisie du post et du lien du jeu dans `/admin/outreach`.
- Extension d'import Reddit reportée jusqu'à ce que son gain soit mesuré.
- Pipeline TypeScript déterministe, preuves structurées et Playwright isolé en
  fallback.
- Queue durable dans SQLite, sans Redis.
- LLM uniquement pour arbitrer entre des liens ou contacts déjà observés.
- Interface Fastify serveur et transport SMTP promotionnel séparé.
- Acquisition remplaçable par adaptateur : saisie, extension ou autre source.

Cette quatrième proposition reprend les points les plus solides des autres
réponses, mais investit d'abord dans le composant réellement chronophage :
l'extraction des sites.

## Légende

Les notes vont de **1 (très défavorable)** à **5 (très favorable)**.

- Une note élevée pour « risque de blocage » signifie que le risque est faible.
- Les durées sont des estimations pour un développeur connaissant le dépôt.
- Les estimations incluent code, tests de sécurité minimaux et intégration,
  mais pas plusieurs semaines d'observation en production.

## Tableau de décision consolidé

Ce tableau ne conserve que les dimensions qui peuvent réellement faire changer
la décision. Les détails de runtime, queue ou framework sont regroupés dans
« développement et maintenance ».

| Dimension décisive | P1 — JSON/RSS auto | P2 — Extension + Trafilatura | P3 — Extension + TypeScript | P4 — MVP progressif |
|---|---|---|---|---|
| **Travail manuel d'acquisition** | Excellent : presque nul | Très bon : un clic, 1–3 min/j | Très bon : un clic, 1–3 min/j | Moyen : saisie post + jeu, 2–5 min/j |
| **Travail manuel de correction/revue** | Moyen : plus d'ambiguïtés attendues | Bon : environ 5–10 min/j | Bon : environ 5–10 min/j | Bon : environ 5–10 min/j |
| **Développement et maintenance** | Élevés : Node, Python, Chromium et endpoint fragile | Très élevés : extension, Node, Python et Chromium | Moyens : extension, Node et Chromium | Faibles à moyens : Node, SQLite et Chromium en fallback |
| **Blocage de la collecte Reddit** | **Risque élevé** : requêtes serveur automatiques | Risque faible à moyen : navigateur réel, mais DOM fragile | Risque faible à moyen : navigateur réel, mais DOM fragile | **Risque très faible** : navigation et sélection humaines |
| **Blocage du crawler par les sites de jeux** | Risque moyen : HTTP puis Playwright | Risque moyen : HTTP puis Playwright | Risque moyen : HTTP puis Playwright | Risque moyen : HTTP puis Playwright, reprise manuelle possible |
| **Qualité de l'extraction** | Moyenne à bonne ; Trafilatura aide le texte, moins les liens | Bonne, mais pipeline complexe | Bonne à très bonne pour liens/e-mails | **Bonne à très bonne**, avec preuves obligatoires |
| **Risque d'erreur ou d'adresse inventée** | Moyen si le LLM cherche un contact absent | Faible à moyen avec revue | Faible : LLM limité aux candidats | **Très faible** : aucune valeur sans preuve source |
| **Risque juridique lié au spam** | Moyen à élevé : collecte automatisée plus large | Moyen avec validation et opposition | Moyen avec validation et opposition | **Le plus faible**, mais non nul : faible volume et sélection humaine |
| **Risque de spam/délivrabilité** | Moyen si cadence mal contrôlée | Moyen si cadence mal contrôlée | Faible à moyen avec SMTP séparé | **Faible à moyen** avec SMTP séparé, 5/j et aucune relance |
| **Sécurité et traçabilité** | Moyenne : crawler serveur étendu | Moyenne : permissions extension + crawler | Bonne | **Très bonne** : preuves, audit, suppression et isolation |
| **Temps de réalisation réaliste** | 12–18 jours | 15–22 jours | 10–15 jours | **7–11 jours statique ; 10–16 avec SPA** |
| **Capacité d'évolution** | Bonne, mais dépend de Reddit | Moyenne à bonne | Bonne | **Très bonne** : acquisition remplaçable |
| **Verdict** | Trop fragile pour le gain obtenu | Possible si le clic unique est prioritaire | Bonne évolution après MVP | **Meilleur choix initial** |

## Scoring centré sur les risques principaux

Les notes vont de **1 (défavorable)** à **5 (favorable)**. Une note élevée sur
un risque signifie que le risque résiduel est faible.

| Critère central | Poids | P1 | P2 | P3 | P4 |
|---|---:|---:|---:|---:|---:|
| Faible travail manuel d'acquisition | 15 % | 5 | 4 | 4 | 3 |
| Faible travail manuel de correction | 10 % | 3 | 4 | 4 | 4 |
| Développement et maintenance raisonnables | 15 % | 2 | 2 | 3 | 4 |
| Faible risque de blocage Reddit | 15 % | 1 | 4 | 4 | 5 |
| Faible risque de blocage des sites | 10 % | 4 | 4 | 4 | 4 |
| Qualité et fiabilité de l'extraction | 15 % | 3 | 4 | 4 | 4 |
| Faible risque juridique de prospection | 10 % | 2 | 3 | 3 | 4 |
| Faible risque pour la délivrabilité | 5 % | 4 | 4 | 4 | 4 |
| Sécurité, preuves et audit | 5 % | 3 | 3 | 3 | 4 |
| **Score pondéré sur 5** | **100 %** | **2,90** | **3,55** | **3,70** | **4,00** |

Le score de P4 baisse par rapport au tableau précédent parce que le travail
manuel est désormais beaucoup plus fortement pondéré. P4 reste premier grâce
à sa simplicité, son faible risque Reddit et sa traçabilité.

## Conditions obligatoires concernant les e-mails

L'architecture technique ne suffit pas à prévenir une plainte ou une mauvaise
réputation. Quel que soit le choix, les garanties suivantes sont obligatoires :

- envoi uniquement après validation humaine ;
- priorité aux adresses génériques ou clairement professionnelles ;
- conservation de la page exacte où l'adresse a été observée ;
- indication dans le message de l'identité de WebGameRank et de la source ;
- moyen simple de s'opposer à tout nouvel envoi ;
- liste d'opposition vérifiée avant chaque envoi ;
- transport et expéditeur distincts des magic links ;
- maximum initial de cinq messages par jour ;
- aucune relance automatique ;
- aucun pixel de suivi d'ouverture ;
- aucun e-mail inventé ou déduit d'un nom.

Sans ces mesures, la note « risque juridique » de toutes les propositions
tombe à **1/5**. La validation humaine réduit le risque, mais ne garantit pas à
elle seule la conformité : la nature professionnelle ou personnelle du contact
reste déterminante.

## Gestion explicite des blocages d'extraction

Le crawler doit considérer un blocage comme un résultat normal et non comme une
raison de contourner la protection.

```text
HTTP direct
   ↓ bloqué, vide ou SPA
Playwright isolé
   ↓ toujours bloqué
needs_manual_review
```

Mesures prévues :

- au maximum deux tentatives automatiques ;
- aucun proxy rotatif ;
- aucun contournement de CAPTCHA ;
- pas plus de cinq pages par domaine ;
- temporisation et cache par domaine ;
- bouton permettant à l'opérateur de saisir un contact observé manuellement,
  avec sa page source ;
- mesure du taux de sites bloqués pour décider si Playwright est rentable.

## Comparatif spécifique de l'acquisition Reddit

La collecte Reddit et l'extraction des sites doivent être deux composants
indépendants. Cela permet de changer la première sans réécrire la seconde.

| Mode d'acquisition | Développement | Temps/jour | Blocage | Fragilité | Autonome | Verdict |
|---|---:|---:|---|---|---|---|
| Saisie du post + URL du jeu | 0,5–1 j | 2–5 min | Très faible | Très faible | Non | Meilleur point de départ |
| Bookmarklet « importer cette page » | 1–2 j | <2 min | Faible | Moyenne | Non | Bon M0.5 si CSP/auth maîtrisés |
| Extension Reddit dédiée | 3–5 j | <1 min | Faible à moyen | Moyenne | Non | À construire après mesure du besoin |
| Playwright avec profil connecté | 3–6 j | Quasi nul | Moyen à élevé | Élevée | Oui | À éviter sans besoin démontré |
| Endpoint Reddit `.json`/RSS | 1–2 j | Nul | Élevé | Très élevée | Oui | Ne pas choisir comme fondation |
| API Reddit approuvée | Variable | Nul | Faible | Faible | Oui | Hors contrainte actuelle |

### Conclusion acquisition

L'extension économise seulement quelques minutes par jour. Elle ne résout pas
le problème difficile de l'analyse des sites. Il est préférable de livrer
l'extracteur d'abord, de mesurer le temps réellement perdu à saisir les liens,
puis de financer ou non l'extension.

## Comparatif spécifique de l'extraction

| Stratégie | Statique | SPA | Complexité | Qualité liens/e-mails | Coût | Verdict |
|---|---|---|---|---|---|---|
| Trafilatura seul | Bon pour texte principal | Mauvais | Moyenne avec Python | Moyenne | Faible | Insuffisant |
| Playwright partout | Bon | Très bon | Élevée | Bonne | Élevé | Disproportionné |
| HTTP + Trafilatura + Playwright | Très bon texte | Très bon | Élevée | Bonne | Moyen | Valable si texte éditorial utile |
| HTTP + DOM TypeScript + Playwright | Très bon | Très bon | Moyenne | Très bonne | Faible | Recommandé |
| LLM sur HTML brut | Variable | Après rendu seulement | Moyenne | Risque d'erreur | Variable | À éviter |
| DOM déterministe + LLM arbitre | Très bon | Très bon | Moyenne | Très bonne avec revue | Faible | Recommandé |

### Pourquoi ne pas commencer par Trafilatura

Le besoin principal porte sur des objets structurés :

- ancres et URL ;
- attributs `href` ;
- liens `mailto:`;
- texte et destination des liens de navigation ;
- formulaires ;
- JSON-LD et métadonnées ;
- relation entre l'adresse et sa page source.

Un parseur DOM TypeScript répond directement à ce besoin. Trafilatura devient
intéressant si l'on constate ensuite que l'extraction du texte éditorial
améliore significativement le choix du site officiel ou la personnalisation.

## Corrections et réserves sur les analyses reçues

### Endpoint Reddit JSON/RSS

L'affirmation selon laquelle l'endpoint `.json` serait « toléré à bas volume »
ne doit pas être considérée comme une garantie. Il s'agit d'une dépendance non
contractuelle dans ce contexte, susceptible de répondre `403`, `429`, de
changer ou d'être retirée. L'absence de cookie ne signifie pas « aucun risque
de ban ».

### Trafilatura dans un worker Node

Trafilatura est une bibliothèque Python. L'utiliser depuis Gamerank implique :

- un worker Python ;
- un subprocess contrôlé ;
- ou un microservice supplémentaire.

Ce coût peut être justifié, mais il ne faut pas le présenter comme une simple
dépendance d'un worker Node.

### Extension qui parcourt aussi les sites externes

Faire crawler les sites par l'extension :

- demande des permissions d'hôtes larges ;
- expose le navigateur utilisateur au contenu visité ;
- complique la distribution et la maintenance ;
- rend les résultats moins reproductibles ;
- déplace le risque SSRF au lieu de supprimer tout risque.

L'extension devrait se limiter à l'acquisition Reddit. Le backend isolé doit
analyser les sites externes.

### Détection SPA par seuil de 100 caractères

Une page de contact légitime peut être très courte. À l'inverse, une coquille
SPA peut contenir beaucoup de texte secondaire. Le fallback Playwright doit
combiner plusieurs signaux :

- présence ou absence de liens/contact observables ;
- racine applicative vide ;
- scripts de bundles et marqueurs de frameworks ;
- contenu principal absent ;
- JSON-LD ou données embarquées ;
- échec de l'extraction malgré des liens internes plausibles.

### `networkidle` avec des jeux web

Les jeux, analytics et connexions temps réel peuvent empêcher `networkidle`.
Il vaut mieux utiliser :

- `domcontentloaded` ;
- une attente bornée ;
- un sélecteur ciblé lorsque disponible ;
- puis une capture de l'état courant.

### Usage du LLM

Un LLM ne doit jamais recevoir l'instruction « trouve un e-mail » lorsqu'aucun
e-mail n'a été extrait. Il pourrait en inventer un.

Il peut :

- classer des liens observés ;
- choisir entre plusieurs pages candidates ;
- qualifier une adresse déjà extraite ;
- proposer un brouillon personnalisé à partir de faits sourcés.

La sortie doit référencer l'identifiant d'un candidat observé, jamais fournir
une nouvelle adresse libre.

### Normalisation Gmail et suivi d'ouverture

- Retirer automatiquement les points ou suffixes `+` d'une adresse Gmail peut
  fusionner abusivement des contacts et n'est pas nécessaire au MVP.
- Un champ `opened_at` suppose généralement un pixel de suivi. Ce mécanisme
  n'est ni nécessaire ni souhaitable pour ce projet.

### Sécurité SSRF

Une simple liste de préfixes d'IP ne suffit pas. Elle peut bloquer des adresses
publiques et manquer IPv6, redirections ou rebinding DNS. Il faut réutiliser et
durcir le composant SSRF existant de Gamerank :

- validation à chaque redirection ;
- résolution DNS contrôlée ;
- rejet de toutes les plages non publiques IPv4 et IPv6 ;
- connexion à l'adresse préalablement validée ;
- limites de temps, taille, type et nombre de pages ;
- isolation réseau du navigateur.

## Architecture P4 recommandée

### Principes

1. Séparer acquisition, enrichissement, décision et envoi.
2. Construire d'abord le cœur à forte valeur : l'extracteur.
3. Garder toutes les opérations déterministes et sourcées.
4. Utiliser Playwright seulement lorsqu'il apporte une information absente.
5. Garder le LLM hors du chemin nominal.
6. Ne jamais envoyer sans validation humaine.
7. Éviter Redis, Python et un frontend séparé dans le MVP.

### Flux

```text
Saisie du post + URL du jeu
            ↓
      source_candidate
            ↓
        job SQLite
            ↓
HTTP sécurisé → parseur DOM → preuves
            ↓ absence de preuve et signaux SPA
 Playwright isolé → DOM rendu → preuves
            ↓ cas ambigu
LLM choisit parmi les preuves existantes
            ↓
 brouillon dans /admin/outreach
            ↓
 correction et validation humaines
            ↓
 vérification suppression + envoi SMTP promo
            ↓
 audit sent / failed / opted_out
```

### Composants

| Composant | Choix MVP | Raison |
|---|---|---|
| Acquisition | Formulaire admin post + URL | Aucun couplage au DOM Reddit |
| API/UI | Fastify SSR existant | Un seul déploiement et design cohérent |
| Queue | Table SQLite, transaction courte et worker unique | Volume faible, reprise durable |
| Worker | Commande TypeScript séparée | Réutilise types, config et sécurité |
| HTML | `fetch` sécurisé + parseur DOM | Rapide, testable, adapté aux liens |
| SPA | Playwright en conteneur non-root | Fallback isolé |
| Classification plateforme | Règles versionnées avec preuves | Déterministe et explicable |
| IA | Arbitre de candidats structurés | Pas d'invention de coordonnées |
| Données | Tables normalisées | Déduplication et audit fiables |
| E-mail | SMTP et expéditeur dédiés | Protège les magic links |
| Frontend | HTML serveur | Pas de React/Vue inutile |

### Modèle de données recommandé

Éviter un unique enregistrement `prospect` contenant tout et un statut global.
Les cycles de vie sont différents.

| Entité | Responsabilité |
|---|---|
| `outreach_sources` | Publication et méthode d'acquisition |
| `outreach_games` | Jeu, URL officielle et domaine canonique |
| `outreach_contacts` | Adresse ou formulaire, catégorie et propriétaire |
| `outreach_evidence` | Valeur observée, source, méthode et date |
| `outreach_game_contacts` | Relation jeu/contact avec rôle et confiance |
| `outreach_jobs` | Étape, tentatives, verrou, prochaine exécution |
| `outreach_drafts` | Sujet, texte et version du modèle |
| `outreach_sends` | Tentative SMTP, identifiant message et résultat |
| `outreach_suppressions` | Opposition par adresse ou domaine |
| `outreach_audit_log` | Décisions humaines et transitions |

### Seuils de sortie

Le système ne doit pas chercher indéfiniment.

| Limite | Valeur MVP proposée |
|---|---:|
| Pages par domaine | 5 |
| Profondeur | 1 |
| Redirections | 3 |
| Taille HTML par page | 2 Mo |
| Timeout HTTP | 8 s |
| Timeout Playwright global | 25 s |
| Navigateurs concurrents | 1 |
| Tentatives automatiques | 2 |
| E-mails par jour | 5 |
| Relances automatiques | 0 |

Ces valeurs sont configurables et devront être ajustées à partir des métriques.

## Plan de livraison conseillé

| Étape | Contenu | Effort |
|---|---|---:|
| M0.1 | Schéma, saisie post/jeu, liste et déduplication | 1–2 j |
| M0.2 | HTTP sécurisé, DOM, plateformes, e-mails et preuves | 2–3 j |
| M0.3 | Revue, brouillon, suppression, SMTP promo | 2–3 j |
| M0.4 | Fixtures, tests SSRF, logs et reprise jobs | 2–3 j |
| **M0 statique utilisable** | **Flux complet sans SPA complexe** | **7–11 j** |
| M1.1 | Playwright isolé et signaux de fallback | 2–3 j |
| M1.2 | Corpus SPA, métriques et ajustement | 1–2 j |
| **M1 SPA** | **MVP complet recommandé** | **10–16 j cumulés** |
| M1.3 optionnel | LLM arbitre avec JSON Schema | 1–2 j |
| M2 optionnel | Extension Reddit si ROI démontré | 3–5 j |

Les fourchettes incluent une marge pour intégrer proprement le code existant.

## Critères de succès du MVP

Après deux semaines d'usage :

- au moins 80 % des URL de jeu soumises ont une classification exploitable ;
- au moins 70 % des contacts retournés sont acceptés sans correction ;
- aucun contact non observé dans une preuve source n'est proposé ;
- moins de 20 % des sites nécessitent une recherche manuelle complète ;
- moins de 5 minutes d'attente opérateur par candidat ;
- aucun doublon envoyé ;
- toute opposition bloque immédiatement les futurs envois ;
- aucun incident sur les e-mails fonctionnels.

## Recommandation finale

Choisir **P4 — MVP progressif centré sur l'extracteur**.

La différence décisive est économique : construire tout de suite une extension
économise quelques minutes quotidiennes, alors que l'extracteur économise la
majorité du temps par candidat. La saisie manuelle sert de frontière stable
pendant que la qualité de l'extraction est mesurée.

Après deux semaines :

- si l'acquisition manuelle dépasse réellement cinq minutes par jour,
  construire l'extension P3 ;
- si la majorité des sites sont correctement traités sans navigateur, ne pas
  ajouter davantage de Playwright ;
- si les erreurs restantes sont principalement sémantiques, ajouter le LLM
  arbitre ;
- si elles sont principalement dues au rendu, améliorer les signaux et le
  corpus Playwright.

La décision est donc réversible : P4 ne bloque aucune évolution vers P3 ou vers
une acquisition officiellement automatisée ultérieure.
