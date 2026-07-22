# Anti-triche du score — WebGameRank

Synthèse technique des défenses contre la manipulation de score (gonflage de
votes / de temps de jeu par un développeur pour faire monter son propre jeu).

## Le principe (à garder en tête)

**On ne peut pas authentifier une requête comme venant « du vrai SDK piloté par
un humain ».** Le développeur contrôle sa page ET son navigateur : la clé SDK est
publique, les en-têtes sont falsifiables, tout secret qu'on envoie au client est
lisible (Kerckhoffs). Il peut même faire tourner notre vrai SDK en headless.

Donc la stratégie n'est **pas** « prouver l'authenticité » (impossible) mais :
1. **rendre la triche pas chère inefficace** → pondération par diversité d'IP ;
2. **éliminer le tier paresseux** → token, tripwire, gates ;
3. **détecter le reste** → compteurs, anomalies (à venir) ;
4. **ne pas donner de feedback** au tricheur → flags silencieux.

Les 4 « tiers » d'attaquant qu'on veut faire monter :
- **T0** curl/Postman en 1 ligne — **éliminé**.
- **T1** script le flux (token, etc.) — fortement gêné.
- **T2** headless + vrai SDK — coûteux, neutralisé au scoring.
- **T3** T2 × proxies résidentiels + persistance — le pro ; visé par la détection (à venir).

---

## Ce qui EXISTE (implémenté + testé)

| Défense | Ce que ça fait | Où | Réglage |
|---|---|---|---|
| **Contrôle d'origine** | events/votes seulement depuis le domaine déclaré du jeu | `ingest.ts` `matchesDeclaredDomain` | — |
| **Gate temps de jeu** | pas de vote sans temps de jeu actif vérifié | `votes.ts` | `VOTE_MIN_ACTIVE_MS` |
| **Jeton de vote one-shot** | vote exige un jeton demandé **au clic réel**, usage unique, TTL court, lié au jeu, haché en base | `votes.ts` `/api/vote-token`, migration 014 | `VOTE_TOKEN_TTL_SECONDS` |
| **1 vote / IP / jeu** | bloque le re-vote après reset du localStorage | `votes.ts` (branche nouveau visitorId) | `VOTE_ONE_PER_IP` |
| **Rate-limit par IP** | anti flood/DoS sur ingest & vote | `ratelimit.ts`, `ingest.ts`, `votes.ts` | `RATE_INGEST_MAX` / `RATE_VOTE_MAX` / `RATE_WINDOW_SECONDS` |
| **Tripwire `ctx`** | le SDK envoie `ctx = mix(token+salt)` ; ctx absent/faux → **flag silencieux** (`suspicious_votes++`, réponse 200 inchangée) | `tripwire.ts`, `widget.ts`, migration 015, admin | `TRIPWIRE_SALTS` (rotation) |
| **Cooldown de changement** | on ne change son vote qu'une fois / 24 h | `votes.ts` | `VOTE_CHANGE_COOLDOWN_HOURS` |
| **1 ligne de vote / (jeu, visiteur)** | contrainte `UNIQUE`, re-vote identique = idempotent | migration 004 | — |
| **Plafonds d'ingestion** | `active_ms ≤ 150 s`/event, `≤ 50` events/batch | `ingest.ts` | `MAX_ACTIVE_MS`, `MAX_EVENTS_PER_BATCH` |
| **Pondération dégressive par préfixe IP** | N votes/visiteurs d'une même IP (ou /24…) → poids qui s'effondre. **Sur les votes ET le temps de jeu.** | `scoring/score.ts` | `prefixLevels`, `VOTE_IP_EXPONENT` |
| **Facteur de partage inter-jeux** | une IP active sur N jeux ne vaut pas N | `scoring/score.ts` | `crossGameExponent` |
| **Wilson lower bound + shrinkage** | quelques votes ne bougent presque pas le score | `scoring/score.ts` | — |

> **Le cœur de la défense** = la **pondération par diversité d'IP** (votes + temps
> de jeu). Tout le reste (token, tripwire, gates, rate-limit) élimine le tier
> paresseux et protège le serveur ; c'est la pondération qui rend la triche à
> l'échelle **sans valeur**.

### Tests
`apps/api/test/` : `vote.test.ts` (token, 1/IP, cooldown, tripwire silencieux,
429), `ingest.test.ts` (origine, plafonds), `ratelimit.test.ts`, `tripwire.test.ts`,
`score.test.ts` (Wilson, IP), `ip.test.ts` (partage inter-jeux).

### Choix assumé : « 1 IP ≈ 1 joueur »
`VOTE_ONE_PER_IP` et le rate-limit par IP traitent volontairement une IP comme
**un joueur**. On **perd un peu de signal** sur les IP réellement partagées
(foyer, CGNAT mobile, école), mais le **gain anti-triche est bien plus grand**,
et c'est **peu risqué pour ce produit** : les jeux sont **de niche**, la
concurrence **par jeu** est faible → il est **improbable** que beaucoup de vrais
joueurs derrière la même IP jouent/votent au **même** mini-jeu quasi inconnu en
même temps. Décision : **on garde les seuils serrés** (`VOTE_ONE_PER_IP=true`,
`RATE_VOTE_MAX=30`). Tunables si un vrai faux positif apparaît en prod.

Deux nuances techniques :
- Le **rate-limit ingest** est **global par IP** (somme tous les jeux) : une
  grosse IP carrier avec beaucoup d'utilisateurs sur des jeux *différents* peut
  l'atteindre. Impact **sur le score ≈ nul** (la pondération IP cape déjà cette
  IP) → c'est de la **protection serveur**, pas de l'anti-triche. Le heartbeat SDK
  est en backoff (5s→135s, ~2-3/min) : `RATE_INGEST_MAX=60` (1/s) couvre les pics
  légitimes d'une IP (reload + multi-onglets) sans plus.
- La **pondération** (scoring), elle, ne **bloque** pas : elle **dé-pèse**. C'est
  le filet sans faux positifs, complémentaire des blocages durs ci-dessus.
- **Origine / tripwire / token** : ~0 valeur contre un attaquant qui lit le JS ou
  rejoue le vrai SDK. Ce sont des ralentisseurs / détecteurs du tier paresseux,
  pas de l'authentification.

---

## Ce qui RESTE à faire (backlog, par ROI décroissant)

1. **Brancher `suspicious_votes` sur la dé-pondération** — aujourd'hui c'est un
   compteur admin ; le connecter au scoring (voter flaggé = poids réduit) lui
   donne des dents. Cheap.
2. **Shadow-discount / score opaque** — score public **retardé, bruité**, et
   contributions suspectes **dé-pondérées en silence**. Prive l'attaquant de son
   oracle d'optimisation. **Meilleur ROI global.** Surtout produit.
3. **Pondération rétention / cohortes de retour** — pondérer sur les joueurs qui
   **reviennent** (J1/J7). Un pool de proxies churn ses IP → ne sait pas simuler
   une présence persistante. Attaque le point faible de T3.
4. **Détection d'anomalie (distribution jointe)** — votes/heure-de-jeu, forme des
   sessions, rythme jour/nuit vs fuseau de l'IP, taux de positivité. L'attaquant
   optimise une métrique et casse la distribution jointe → poids réduit, pas ban.
5. **Signal bot/proxy acheté** (Cloudflare Turnstile / Fingerprint / MaxMind) en
   **pondération** (jamais en CAPTCHA bloquant). Faible effort, mord T2.
6. **Graphe de co-occurrence inter-jeux** — clusters d'identités qui n'apparaissent
   qu'ensemble sur peu de jeux → démasque les **services de boost** payants.
7. **Design économique** — score **provisoire** pour un domaine neuf qui mûrit,
   **settlement retardé + clawback**, **bond dev optionnel** pour être classé.
8. **Sabotage par downvote** — exiger **plus de confiance** pour un downvote que
   pour un upvote (un concurrent peut plomber un rival à moindre coût).
9. **Rate-limit ingest** — ajouter un test d'intégration 429 dédié (mineur ;
   même limiteur que le vote, déjà prouvé).
10. **Rotation du tripwire** — process opérationnel (changer le salt SDK + garder
    l'ancien en grâce puis le retirer) ; déjà supporté par `TRIPWIRE_SALTS`.

> Fil directeur (indépendant de tout le reste) : **arrêter d'authentifier les
> requêtes** (impossible) et **forcer l'attaquant à simuler un écosystème cohérent
> et persistant, puis le dé-pondérer en silence sans lui dire qu'il a échoué.**

---

## Référence des variables d'env

| Variable | Défaut | Rôle |
|---|---|---|
| `VOTE_MIN_ACTIVE_MS` | 10000 | temps de jeu min avant de voter |
| `VOTE_CHANGE_COOLDOWN_HOURS` | 24 | délai entre changements de vote |
| `VOTE_TOKEN_TTL_SECONDS` | 120 | durée de vie du jeton one-shot |
| `VOTE_ONE_PER_IP` | `true` | 1 vote/IP/jeu (`false` = pondéré seulement) |
| `RATE_WINDOW_SECONDS` | 60 | fenêtre du rate-limit |
| `RATE_INGEST_MAX` | 60 | requêtes ingest/IP/fenêtre (~1/s) |
| `RATE_VOTE_MAX` | 30 | requêtes vote(+token)/IP/fenêtre |
| `TRIPWIRE_SALTS` | `wr1:…` | salts acceptés (1er = courant ; rotation) |
