# GameRank — Méthodologie et formules

> **Ce document décrit ce que le code fait réellement**, pas ce que le CDC
> prévoit. Il est destiné à une revue manuelle : chaque formule est donnée
> avec sa localisation dans le code et un exemple chiffré.
>
> État : 20 juillet 2026 · pipeline épic 7 en place · axe jury (P) non
> encore alimenté.
>
> La §11 « Points à challenger » liste les écarts et approximations connus —
> c'est probablement la section la plus utile pour la revue.

## 1. Vue d'ensemble

```text
SDK navigateur
   │  événements bruts (load, session_start, heartbeat, session_end)
   ▼
ClickHouse events                       TTL 3 jours
   │  ÉTAGE 1 — agrégation
   ▼
ClickHouse daily_activity               TTL 45 jours
             daily_sessions
   │  ÉTAGE 2 — métriques brutes + poids anti-triche + décroissance
   ▼
7 métriques par jeu
   │  ÉTAGE 3 — corrections statistiques (Wilson, shrinkage)
   ▼
métriques corrigées
   │  ÉTAGE 4 — normalisation 0-100 (50 % absolu + 50 % percentile)
   ▼
7 sous-scores
   │  ÉTAGE 5 — moyennes pondérées
   ▼
G, Q, P → Score = 0,30·G + 0,55·Q + 0,15·P → rang
```

Les étages 1 à 5 tournent ensemble dans une « passe » (`runPipeline`),
déclenchée toutes les `PIPELINE_INTERVAL_SECONDS` (30 s en dev) et par le
bouton *Recompute now* de l'admin. Une passe ne peut pas se chevaucher avec
la précédente (verrou en mémoire).

| Fichier | Rôle |
|---|---|
| `packages/sdk/src/index.ts` | mesure côté navigateur |
| `apps/api/src/ingest.ts` | validation et stockage des événements |
| `apps/api/src/scoring/aggregate.ts` | étage 1 |
| `apps/api/src/scoring/score.ts` | étages 2 à 5, écriture du classement |
| `apps/api/src/scoring/math.ts` | toutes les fonctions mathématiques pures |
| `apps/api/src/config.ts` | tous les paramètres (section `scoring`) |

## 2. Étage 0 — Ce qui est mesuré

Le SDK n'incrémente le compteur de temps actif **que si les deux conditions
sont vraies**, à chaque seconde :

```text
document.visibilityState === 'visible'
ET  (maintenant − dernier input) < 60 s
```

Les inputs surveillés : `pointerdown`, `pointermove`, `keydown`,
`touchstart`, `wheel`. Un onglet ouvert en arrière-plan ou laissé sans
interaction n'accumule donc pas de temps.

Le temps accumulé est envoyé par heartbeats à cadence exponentielle :

```text
délai(n) = min(5 s × 3^n, 135 s)      → 5 s, 15 s, 45 s, 135 s, 135 s…
```

Remise à 5 s à chaque nouvelle session. Une nouvelle session démarre après
30 minutes sans input. À la fermeture de la page, `session_end` part via
`sendBeacon`.

**Contrôles côté serveur** (`ingest.ts`) — un événement n'est stocké que si :

| Contrôle | Effet |
|---|---|
| clé SDK connue et jeu non masqué | sinon rejet silencieux (204) |
| `Origin`/`Referer` = domaine déclaré (ou sous-domaine) | sinon rejet silencieux |
| type ∈ {load, session_start, heartbeat, session_end} | sinon l'événement est filtré |
| `activeMs` ∈ [0, 150 000] | sinon plafonné à 150 000 |
| ≤ 50 événements par lot | au-delà, tronqué |

L'horodatage est posé **par le serveur** (`ts DEFAULT now()`), jamais par le
client. L'IP est normalisée (§6.1) avant stockage.

## 3. Étage 1 — Agrégation

Deux tables ClickHouse `ReplacingMergeTree`, ré-écrites intégralement à
chaque passe depuis la fenêtre d'événements bruts (3 jours). L'opération est
donc **idempotente** : rejouer une passe ne double aucun compteur.

```sql
daily_activity(game_id, visitor_id, day)
  active_ms = Σ active_ms
  sessions  = nb d'événements session_start
  loads     = nb d'événements load
  ip        = any(ip)          -- une IP représentative du couple visiteur/jour

daily_sessions(game_id, session_id, day)
  active_ms = Σ active_ms de la session
  day       = jour du PREMIER événement de la session
```

## 4. Étage 2 — Les 7 métriques brutes

Notations : `d` = un jour, `age(d)` = nombre de jours écoulés depuis `d`.

### 4.1 Décroissance temporelle

Toutes les métriques de volume sont pondérées par :

```text
poids(d) = 0,95 ^ age(d)
```

L'âge est compté en **jours calendaires** (`floor`) : l'activité du jour même
a un âge de 0 et n'est donc pas décotée.

| Ancienneté | Poids |
|---|---|
| aujourd'hui | 1,000 |
| 7 jours | 0,698 |
| 13,5 jours | 0,500 ← demi-vie |
| 30 jours | 0,215 |
| 40 jours | 0,129 |
| 45 jours | 0,099 (limite de rétention) |

Le calcul **n'est pas incrémental** : à chaque passe, la somme est
recalculée depuis les 45 jours d'agrégats disponibles. C'est auto-réparant
(aucun état corrompu possible) mais la queue au-delà de 45 jours est perdue
(≈ 10 % du poids théorique).

### 4.2 Gv — Visiteurs qualifiés pondérés

Un visiteur est **qualifié** un jour donné s'il a cumulé ≥ 30 s de temps
actif ce jour-là (`QUALIFIED_VISITOR_MS`).

```text
Gv_brut = Σ_jours [ visiteursEffectifs(jour) × 0,95^age(jour) ]
```

où `visiteursEffectifs` applique le poids anti-triche par préfixe IP
détaillé en §6.

### 4.3 Gt — Temps actif cumulé

```text
Gt_brut = Σ_jours [ (Σ active_ms du jour) × 0,95^age(jour) ]
```

Exprimé en heures au moment de la normalisation.

### 4.4 Gx — Votants

```text
Gx_brut = nombre de lignes dans la table votes pour ce jeu
```

Non décroissant (les votes sont une donnée durable en PostgreSQL).

### 4.5 Qr — Fidélisation par cohorte

```text
cohorte  = visiteurs dont le PREMIER jour d'activité date d'il y a ≥ 7 jours
revenus  = ceux ayant ≥ 2 journées actives (≥ 60 s chacune)

Qr_brut  = revenus / cohorte            (échantillon = |cohorte|)
```

Le délai de 7 jours (`COHORT_DAYS`) évite de pénaliser un jeu en croissance :
les visiteurs arrivés hier n'ont pas encore *pu* revenir, ils sont exclus du
dénominateur.

### 4.6 Qs — Durée médiane de session

```text
Qs_brut = médiane( active_ms des sessions des 30 derniers jours, active_ms > 0 )
```

Médiane exacte (`quantileExact(0.5)`), pas moyenne : une poignée de sessions
extrêmes ne déforme pas la valeur. Échantillon = nombre de sessions.

### 4.7 Qv — Approbation

```text
Qv_brut = borneWilson(votes positifs, total des votes)     → §5.1
```

### 4.8 Qe — Taux de jeu significatif

```text
Qe_brut = min( Gv_brut / loads_décroissants , 1 )
```

Lecture : « part des chargements qui deviennent du jeu réel ».

## 5. Étage 3 — Corrections statistiques

### 5.1 Borne inférieure de Wilson (approbation)

Répond à : *avec ce volume de votes, quel taux d'approbation peut-on
garantir à 95 % ?* — z = 1,96.

```text
p̂ = positifs / n

           p̂ + z²/(2n) − z·√( p̂(1−p̂)/n + z²/(4n²) )
Wilson =  ────────────────────────────────────────────
                        1 + z²/n
```

| Votes | Taux brut | Wilson |
|---|---|---|
| 3⁺ / 0⁻ | 100 % | **43,8 %** |
| 9⁺ / 1⁻ | 90 % | **59,6 %** |
| 90⁺ / 10⁻ | 90 % | **82,6 %** |
| 900⁺ / 100⁻ | 90 % | **88,0 %** |

Aucun paramètre à calibrer : le volume fait tout le travail. Un jeu sans
aucun vote reçoit le prior global (§5.3) au lieu d'une valeur nulle.

### 5.2 Shrinkage (fidélisation, médiane, engagement)

```text
                          échantillon
corrigé = prior + ───────────────────────── × (observé − prior)
                    échantillon + k
```

| Métrique | k | Échantillon utilisé |
|---|---|---|
| Fidélisation | 20 | taille de la cohorte |
| Médiane de session | 20 | nombre de sessions |
| Engagement | 50 | nombre de chargements |

Exemple (fidélisation observée 50 %, prior global 15 %) :

| Cohorte | Corrigé |
|---|---|
| 5 visiteurs | 22,0 % |
| 20 visiteurs | 32,5 % |
| 100 visiteurs | 44,2 % |
| 1000 visiteurs | 49,3 % |

### 5.3 Priors empiriques

Les priors ne sont **pas des constantes** : à chaque passe, c'est la moyenne
observée sur l'ensemble des jeux mesurés. Valeurs de repli si aucun jeu
n'est mesurable : fidélisation 0,10 · médiane 60 000 ms · approbation 0,50 ·
engagement 0,30.

## 6. Poids anti-triche par préfixe IP

### 6.1 Normalisation d'adresse

```text
::ffff:81.2.3.4   →  IPv4 81.2.3.4      (socket dual-stack)
2a01:e0a::1%en0   →  IPv6 2a01:e0a::1   (zone retirée)
```

Les IPv6 compressées sont développées en 8 groupes de 16 bits avant
masquage. IPv4 et IPv6 ne se mélangent jamais (les clés de préfixe sont
préfixées `v4/` ou `v6/`).

### 6.2 Les 5 niveaux

| Niveau | IPv4 | IPv6 | Exposant α |
|---|---|---|---|
| bloc opérateur | /8 | /32 | 0,90 |
| région | /16 | /48 | 0,85 |
| allocation FAI | /20 | /56 | 0,75 |
| foyer | /24 | /64 | 0,65 |
| adresse exacte | /32 | /128 | 0,50 |

En IPv6, le **/64 joue le rôle du /32 IPv4** : un foyer possède un /64
entier et les extensions de confidentialité font tourner les /128.

### 6.3 Formule

Pour un jeu et un jour donnés, à partir du nombre de visiteurs qualifiés
distincts par IP :

```text
Pour chaque niveau L :
    total(L) = Σ_préfixes (visiteurs du préfixe) ^ α(L)

visiteursEffectifs = min over L de total(L)
```

Le niveau le **plus restrictif** l'emporte.

### 6.4 Exemples chiffrés

**Concentration (botnet)** — 100 visiteurs, tous dans la même /24 :

```text
/32 : 100 IP distinctes → 100 × 1^0,50 = 100,0
/24 : 1 préfixe de 100  → 100^0,65      =  20,0   ← minimum
→ visiteursEffectifs ≈ 20 au lieu de 100
```

**Dispersion (trafic honnête)** — 100 visiteurs sur 50 blocs /8 différents :

```text
/32 : 100 × 1^0,50            = 100,0
/24 : 100 préfixes distincts  = 100,0
/8  : 50 préfixes de 2        =  93,3   ← minimum
→ visiteursEffectifs ≈ 93
```

**Foyer IPv6 qui fait tourner ses adresses** — 200 adresses dans un /64 :

```text
/128 : 200 × 1^0,50   = 200,0
/64  : 200^0,65       =  31,3   ← minimum
```

## 7. Étage 4 — Normalisation 0-100

Chaque métrique corrigée devient un sous-score :

```text
sous-score = 0,5 × échelleAbsolue + 0,5 × rangPercentile
```

### 7.1 Échelle absolue

Logarithmique pour les volumes, linéaire pour les ratios, bornée à [0, 100] :

```text
absLog(v, R)    = 100 × ln(1+v) / ln(1+R)
absLinéaire(v,R)= 100 × v / R
```

| Métrique | Type | Borne R |
|---|---|---|
| Gv (visiteurs) | log | 1000 |
| Gt (heures actives) | log | 500 |
| Gx (votants) | log | 200 |
| Qr (fidélisation) | linéaire | 0,40 |
| Qs (minutes médianes) | log | 15 |
| Qv (approbation) | linéaire | 1,00 |
| Qe (engagement) | linéaire | 1,00 |

Effet du log sur Gv (R = 1000) :

| Visiteurs | Échelle absolue |
|---|---|
| 10 | 34,7 |
| 100 | 66,8 |
| 500 | 90,0 |
| 1000 | 100,0 |
| 5000 | 100,0 (plafonné) |

### 7.2 Rang percentile

```text
rang = 100 × (position dans l'ordre croissant) / (nombre de jeux − 1)
```

0 = dernier, 100 = premier, ex æquo moyennés. **Un seul jeu classé → 50.**

## 8. Étage 5 — Agrégation finale

```text
G = 0,50·Gv + 0,35·Gt + 0,15·Gx
Q = 0,35·Qr + 0,25·Qs + 0,25·Qv + 0,15·Qe
P = 2/7 × 100 = 28,57          (constante tant que le jury n'existe pas)

Score = 0,30·G + 0,55·Q + 0,15·P
```

Moyennes pondérées (compensatoires), jamais de norme vectorielle ni de
produit — un point faible se rattrape ailleurs, et la formule reste
explicable.

### 8.1 Score A (comparaison interne)

Calculé en parallèle, stocké, jamais affiché — c'est la proposition v1 à
percentiles purs, gardée pour comparer la stabilité des deux approches :

```text
Score A = ½ · moyenne(rang Gv, rang Gt, rang votes positifs)
        + ½ · moyenne(rang fidélisation brute, rang médiane brute,
                      rang taux de votes positifs)
```

## 9. Exemple complet de bout en bout

Jeu fictif, 40 jeux classés au total :

```text
MESURES BRUTES
  visiteurs qualifiés pondérés     120   (après poids IP et décroissance)
  temps actif cumulé                60 h
  votants                           40   (34 positifs, 6 négatifs)
  cohorte fidélisation              80 visiteurs, 26 revenus
  sessions                         300, médiane 4 min
  chargements pondérés             200

CORRECTIONS  (priors : fidélité 0,15 · médiane 3 min · engagement 0,30)
  Qr : observé 32,5 %, n=80  → 0,15 + (80/100)×(0,325−0,15)     = 29,0 %
  Qs : observé 4 min, n=300  → 3 + (300/320)×(4−3)              = 3,94 min
  Qv : Wilson(34, 40)                                            = 70,9 %
  Qe : observé 120/200 = 0,60, n=200 → 0,30+(200/250)×0,30       = 54,0 %

NORMALISATION  (percentiles supposés : Gv 70, Gt 65, Gx 80,
                Qr 75, Qs 60, Qv 72, Qe 68)
  Gv = ½×absLog(120, 1000)  + ½×70 = ½×69,4 + 35   = 69,7
  Gt = ½×absLog(60, 500)    + ½×65 = ½×66,2 + 32,5 = 65,6
  Gx = ½×absLog(40, 200)    + ½×80 = ½×70,0 + 40   = 75,0
  Qr = ½×absLin(0,29 / 0,40)+ ½×75 = ½×72,5 + 37,5 = 73,8
  Qs = ½×absLog(3,94 / 15)  + ½×60 = ½×57,6 + 30   = 58,8
  Qv = ½×70,9               + ½×72 = 71,5
  Qe = ½×54,0               + ½×68 = 61,0

AGRÉGATION
  G = 0,50×69,7 + 0,35×65,6 + 0,15×75,0 = 69,1
  Q = 0,35×73,8 + 0,25×58,8 + 0,25×71,5 + 0,15×61,0 = 67,5
  P = 28,57

  Score = 0,30×69,1 + 0,55×67,5 + 0,15×28,57 = 62,1
```

> Tous les chiffres de cette section ont été produits en exécutant les
> fonctions réelles (`math.ts`) avec les paramètres réels (`config.ts`),
> pas recalculés à la main.

## 10. Paramètres et valeurs actuelles

Tous dans `config.ts` (section `scoring`), surchargeables par variables
d'environnement.

| Paramètre | Valeur | Variable |
|---|---|---|
| Cadence du pipeline | 30 s | `PIPELINE_INTERVAL_SECONDS` |
| Facteur de décroissance | 0,95 / jour | `DECAY_FACTOR` |
| Visiteur qualifié | 30 s | `QUALIFIED_VISITOR_MS` |
| Journée active | 60 s | `ACTIVE_DAY_MS` |
| Délai de cohorte | 7 jours | `COHORT_DAYS` |
| Fenêtre médiane | 30 jours | — |
| P par défaut | 2/7 | `PEER_DEFAULT_RATIO` |
| Exposants IP | 0,90 / 0,85 / 0,75 / 0,65 / 0,50 | — |
| k de shrinkage | 20 / 20 / 50 | — |
| Bornes de référence | §7.1 | — |
| Pondérations | §8 | — |
| Temps minimal pour voter | 10 s (dev) | `VOTE_MIN_ACTIVE_MS` |
| Délai de changement de vote | 24 h | `VOTE_CHANGE_COOLDOWN_HOURS` |

## 11. Points à challenger en revue

Écarts connus entre l'intention et l'implémentation, et choix discutables.
**C'est ici qu'une revue manuelle a le plus de valeur.**

### 11.1 « Visiteurs uniques » sont en réalité des visiteur-jours

Le CDC parle de *visiteurs uniques qualifiés*. Le code somme, pour chaque
jour, les visiteurs qualifiés **de ce jour**, avec décroissance. Un joueur
fidèle présent 20 jours compte donc ≈ 20 fois, pas 1.

**Conséquence** : la fidélité est récompensée deux fois — dans G (via Gv) et
dans Q (via Qr). C'est peut-être souhaitable, mais ce n'est pas ce que le
CDC décrit. L'alternative serait `uniqExact(visitor_id)` sur toute la
fenêtre, mais elle est incompatible avec la décroissance jour par jour.
**Décision à prendre.**

### 11.2 Plafonnement des gros volumes, même honnêtes

Le niveau /8 avec α = 0,90 s'applique à tout le monde. Un jeu avec 10 000
visiteurs honnêtes majoritairement français (donc concentrés sur quelques
/8 opérateurs) est ramené à ≈ 4 000. Combiné à l'échelle logarithmique,
cela fait un **double amortissement** des gros volumes.

C'est cohérent avec l'objectif anti-winner-take-all, mais l'effet cumulé
n'a pas été quantifié. **À surveiller sur données réelles.**

### 11.3 Le score maximum atteignable est 89,3 / 100

Comme P est figé à 28,57 tant que le jury n'existe pas :

```text
Score_max = 0,30×100 + 0,55×100 + 0,15×28,57 = 89,3
```

Sans effet sur l'ordre du classement (constante identique pour tous), mais
l'échelle affichée est trompeuse. Options : normaliser l'affichage, ou
accepter que les scores montent à l'arrivée du jury.

### 11.4 Numérateur pondéré / dénominateur brut dans Qe

`Qe = Gv_pondéré / loads_bruts`. Le numérateur subit le poids anti-triche
(sous-linéaire), pas le dénominateur. Un jeu à trafic concentré voit donc
son engagement **doublement** pénalisé : une fois dans Gv, une fois dans Qe.

### 11.5 Fidélisation ≈ « 2 journées actives », pas « revenu après le J1 »

Le code teste `≥ 2 journées actives` sur toute la fenêtre. Deux sessions le
même jour ne comptent pas ; deux jours consécutifs comptent autant que
J1 + J30. Une définition par fenêtre de retour (J1-J7) serait plus fine.

### 11.6 Sessions déclarées par le client

`session_id` est généré par le SDK. Un client malveillant peut fabriquer des
sessions courtes ou longues pour manipuler la médiane (Qs). Le plafond de
150 s par événement limite l'ampleur, mais la métrique reste la plus
falsifiable des sept — d'où son poids modeste (25 % de Q, soit 13,75 % du
score final).

### 11.7 Une IP par visiteur et par jour

`daily_activity.ip = any(ip)` : si un visiteur change de réseau dans la
journée, une seule IP est retenue arbitrairement. Acceptable pour de
l'anti-triche statistique, à connaître.

### 11.8 Instabilité du percentile à faible effectif

Avec 4 jeux classés, les rangs possibles sont 0, 33, 67, 100. L'ajout d'un
5e jeu déplace mécaniquement tous les autres. Le mélange 50/50 avec
l'échelle absolue amortit, sans supprimer, cet effet.

### 11.9 Facteur ASN non implémenté

Prévu au CDC §4.2, différé faute de clé MaxMind. Facteur ×1,0 partout — les
requêtes venant de datacenters ne sont donc **pas** dévaluées aujourd'hui.

### 11.10 Priors calculés sur l'ensemble incluant les jeux non mesurés

Les priors sont la moyenne des jeux ayant une valeur non nulle, ce qui
inclut des jeux à très faible échantillon. Un prior légèrement bruité au
démarrage est donc possible (auto-corrigé quand le volume monte).

## 12. Ce que les tests vérifient déjà

`npm test` — 37 tests. Les scénarios de scoring et d'IP **affichent leurs
entrées et leurs résultats chiffrés** dans la sortie (tableaux alignés), ce
qui permet de juger l'ampleur des écarts et pas seulement le succès :

```text
  jeu                Gv pondéré  Gt (h)  fidélité          approb.  G     Q     Score  rang
  gros médiocre      403.4       13.1    0,0 % → 0,6 %     24,6 %   83,3   9,3   34,4   #12
  petit excellent    101,9       10,7    100,0 % → 55,6 %  81,1 %   73,1  87,1   74,1   #1
```

5 scénarios synthétiques de scoring :

| Test | Propriété vérifiée |
|---|---|
| petit-excellent > gros-médiocre | la qualité peut battre le volume |
| botnet /24 < trafic dispersé | 400 faux visiteurs pèsent moins que 100 vrais |
| Wilson 90/100 > 3/3 | le volume de votes prime sur le taux brut |
| décroissance à 40 jours | l'activité ancienne pèse ≈ 8× moins |
| run historisé | durée, statut, scores courants écrits |

Plus 5 tests dédiés au traitement des IP (normalisation IPv4-mappée,
IPv6 compressée, niveaux de préfixe, rotation dans un /64, mélange v4/v6).
