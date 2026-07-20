# Cahier des charges v2 — Classement des jeux web

> Version 2 — intègre les décisions prises en revue (juillet 2026).
> Remplace la v1. Les changements majeurs par rapport à la v1 sont signalés par **[v2]**.

## 1. Objectif

Créer un site public classant des jeux web à partir de données d'usage réelles
collectées par un SDK JavaScript.

Le classement doit éviter deux biais :

* favoriser automatiquement les jeux ayant déjà beaucoup de trafic ;
* surévaluer un jeu sur la base de deux ou trois visiteurs seulement.

Le système distingue :

```text
Grandeur   : importance totale atteinte par le jeu
Qualité    : comportement des joueurs après leur arrivée
Confiance  : quantité de données disponible
```

Un seul classement officiel est produit, mis à jour toutes les 5 minutes,
avec un score public de 0 à 100. La méthode de calcul est publiquement
documentée.

**[v2]** Le risque principal du projet n'est pas mathématique mais double :
l'**adoption** du SDK (œuf et poule : il faut des devs pour avoir des données,
du trafic pour attirer des devs) et la **triche** (un SDK client est
falsifiable ; la crédibilité du classement repose sur l'anti-triche).
Ces deux sujets sont traités au même niveau que la formule de score.

## 2. Données collectées

Pour chaque jeu :

* visiteurs uniques (pondérés, voir §4) ;
* temps de jeu actif cumulé ;
* durée des sessions ;
* jours actifs distincts par visiteur ;
* votes positifs et négatifs ;
* chargements ou débuts de partie ;
* version du SDK ;
* identifiants anonymes de session et de visiteur.

Le temps est compté uniquement lorsque :

* la page est visible ;
* une activité récente est détectée ;
* la durée déclarée reste cohérente avec le temps réellement écoulé.

## 3. Identifiant visiteur **[v2]**

```text
Identifiant : UUID aléatoire stocké en localStorage, par jeu
Pas de fingerprinting (canvas, WebGL, polices…)
Pas d'identité inter-sites
```

Justification :

* la fidélisation et les votes sont mesurés **par jeu** : une identité
  inter-sites est inutile ;
* l'identifiant est first-party du point de vue du navigateur (le SDK tourne
  sur le domaine du jeu) : non bloqué ;
* le fingerprinting exigerait un consentement CNIL explicite, est activement
  combattu par les navigateurs (collisions massives sur mobile), et est
  contraire au positionnement transparence du site.

Limites assumées : Safari plafonne le stockage script à 7 jours sans revisite
→ légère sous-estimation de la fidélisation, **uniforme entre jeux**, donc
neutre pour un classement relatif.

Principe directeur : **aucun identifiant client n'est infalsifiable**.
L'identifiant sert à compter les visiteurs honnêtes ; la détection des
tricheurs se fait côté serveur (§4).

## 4. Anti-triche : poids d'un visiteur **[v2]**

Chaque visiteur unique compte pour un poids entre 0 et 1 :

```text
poids d'un visiteur =
    poids dégressif par préfixe IP (par jeu)
  × facteur ASN
  × validité comportementale
```

### 4.1 Poids dégressif par préfixe IP

Au sein d'un même préfixe, pour un même jeu, chaque visiteur supplémentaire
compte de moins en moins. **Cinq niveaux**, du plus large au plus fin, avec
une dégressivité de moins en moins sévère en remontant (un bloc opérateur
national ne doit pas écraser un jeu populaire légitime) :

```text
niveau     IPv4   IPv6    exposant
bloc FAI   /8     /32     0,90
région     /16    /48     0,85
allocation /20    /56     0,75
foyer      /24    /64     0,65
exact      /32    /128    0,50

contribution d'un préfixe = (visiteurs du préfixe) ^ exposant
poids retenu = le niveau le plus restrictif
```

Exemple : 100 visiteurs depuis la même /24 ≈ 20 visiteurs comptés.

**IPv6** (~40-45 % du trafic) : les adresses IPv4-mappées (`::ffff:…`)
sont normalisées en IPv4 avant groupement. Le **/64 joue le rôle du /32
IPv4** — un foyer dispose d'un /64 entier et les extensions de
confidentialité font tourner les /128, donc l'adresse exacte n'est pas une
identité exploitable de ce côté.

**Partage inter-jeux.** Les buckets ci-dessus sont internes à chaque jeu ;
s'y ajoute une dimension plateforme : un préfixe hyperactif sur beaucoup de
jeux (sortie VPN partagée, ferme de bots, même joueur partout) ne compte
pas N fois.

```text
part du jeu = (usage du préfixe sur ce jeu / usage plateforme, même jour)^(1−γ)
γ = 0,70 (configurable ; 1 = désactivé)

IP fidèle à 1 jeu        → facteur 1 (inchangé)
IP répartie sur 10 jeux  → ≈ 5 « joueurs » au total, pas 10
```

Les **votes** suivent la même logique (l'IP est stockée avec chaque vote) :
n votes d'une même IP sur un même jeu valent n^0,5 votes effectifs — ce qui
ferme la faille « vider le localStorage et revoter » — et le partage
inter-jeux s'applique aussi. Wilson est calculé sur les comptes effectifs.

Nota : il n'existe pas d'identifiant joueur transverse aux jeux, et c'est
irrémédiable côté navigateur (stockage partitionné par site hôte) ; l'IP
est la seule identité inter-jeux observable, d'où ce mécanisme statistique.

Un poids dégressif est préféré à un quota dur : pas d'effet de seuil
contournable, et les concentrations légitimes (campus, CGNAT mobile,
événement local) gardent l'essentiel de leur poids.

### 4.2 Facteur ASN — **reporté après le MVP**

Nécessite la base MaxMind GeoLite2-ASN (clé de compte gratuite). Il s'agit
d'un **lookup local** sur un fichier téléchargé : aucun appel réseau par
requête, donc aucun impact de latence ni de scalabilité. Facteur ×1,0 en
attendant ; le poids par préfixe IP (§4.1) assure seul la défense au MVP.

Chaque IP est résolue vers son ASN :

```text
résidentiel / mobile     × 1,0
VPN grand public connu   × 0,3
hébergeur / datacenter   × 0,1
```

Pas de poids 0 brutal : un multiplicateur adoucit les faux positifs (joueurs
sous VPN). Ces faux positifs sont répartis uniformément entre jeux, donc
neutres pour le classement ; la triche, elle, est ciblée sur un jeu.

### 4.3 Validité comportementale

Cohérence temporelle des sessions (déjà mesurée par le SDK), diversité des
User-Agents, plausibilité des horaires, distribution des durées.

### 4.4 Marquage, pas de sanction automatique

Une concentration anormale (ex. 80 % du trafic sur un /24 résidentiel)
**marque le jeu pour revue manuelle** mais ne le déclasse pas
automatiquement : les faux positifs existent (campus, streamer), et un
déclassement injuste détruirait la confiance des développeurs.

### 4.5 Objectif économique

Le but n'est pas « zéro triche » (impossible côté client) mais l'escalade de
coût :

```text
botnet datacenter          ~ gratuit   → tué par le facteur ASN
concentration résidentielle bon marché → tuée par le poids dégressif
proxies résidentiels        cher       → rentabilité détruite par le coût
                                         + détection comportementale
```

À chaque palier, tricher coûte plus cher que promouvoir honnêtement son jeu.

## 5. Accumulation temporelle **[v2]**

La fenêtre glissante dure de 30 jours est remplacée par des **cumuls à
décroissance exponentielle** :

```text
cumul_aujourd'hui = cumul_hier × 0,95 + activité_du_jour
```

* demi-vie ≈ 14 jours (équivalent en esprit à la fenêtre de 30 jours) ;
* un seul accumulateur par métrique et par jeu, pas de reparcours
  d'historique ;
* pas d'effet de falaise (un pic ne sort pas brutalement de la fenêtre au
  jour 31) ;
* favorise naturellement les jeux en croissance sur les jeux en déclin à
  volume égal.

Le facteur 0,95 est un paramètre configurable (§13).

## 6. Normalisation des métriques **[v2]**

Le percentile pur de la v1 est remplacé par un mix, pour chaque métrique :

```text
sous-score = 50 % × échelle absolue + 50 % × rang percentile
```

* **Échelle absolue** : `log(1 + x)` ramené sur 0-100 par rapport à des
  bornes de référence fixes pour les métriques de volume ; échelle linéaire
  sur bornes de référence fixes pour les ratios (ex. fidélisation :
  0 % → 0, 40 % → 100). Les bornes sont recalibrées rarement.
* **Rang percentile** : 0 = dernier, 50 = médian, 100 = premier, parmi les
  jeux éligibles.

Justification : le percentile est instable quand il y a peu de jeux et le
score d'un jeu bouge quand les autres bougent ; le log est stable et absolu
mais garde un avantage aux très gros. Chaque moitié amortit le défaut de
l'autre. Le ratio 50/50 est configurable.

## 7. Métriques

Toutes les métriques sont calculées sur les cumuls décroissants (§5), avec
les visiteurs pondérés (§4).

### 7.1 Grandeur

```text
Gv = visiteurs uniques qualifiés (≥ 30-60 s de jeu)
Gt = temps actif cumulé
Gx = nombre total de votants
```

Pondération :

```text
G = 50 % Gv + 35 % Gt + 15 % Gx
```

Note : ces trois métriques sont corrélées (~0,9). La redondance est
**volontaire** : elle sert la robustesse anti-triche — falsifier trois
métriques de façon cohérente est nettement plus dur qu'en gonfler une, et
l'incohérence entre elles est elle-même un signal de fraude (pic de
visiteurs sans temps proportionnel, votes sans sessions…). Les pondérations
reflètent la **fiabilité** (difficulté de falsification), pas seulement
l'information.

### 7.2 Qualité

**Fidélisation — par cohorte [v2]**

```text
fidélisation =
    visiteurs revenus un autre jour
  / visiteurs arrivés il y a au moins 7 jours
```

La définition v1 (revenus / uniques 30 j) pénalisait les jeux en croissance :
les visiteurs d'hier n'ont pas encore pu revenir. La version par cohorte
élimine ce biais. Une journée est active à partir de 60 s de jeu.

**Durée typique de session**

```text
durée médiane des sessions actives
```

Poids plafonné volontairement : la durée de session mesure le genre autant
que la qualité (un bon puzzle quotidien = 3 min, un idle médiocre = 40 min),
et c'est la métrique la plus facile à gonfler passivement.

**Approbation — borne inférieure de Wilson [v2]**

```text
wilson = (p̂ + z²/2n − z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)
p̂ = votes positifs / total votes ; z = 1,96 (95 %)
```

Repères :

```text
3⁺/0⁻    → 44 %
9⁺/1⁻    → 60 %
90⁺/10⁻  → 83 %
```

Wilson remplace la correction de confiance v1 pour les votes : zéro
paramètre à calibrer, fondement statistique standard (tri Reddit).

**[v2]** Le vote n'est autorisé qu'après un **temps de jeu minimal**
(paramètre configurable, ex. 60 s).

**Taux de jeu significatif**

```text
taux = visiteurs ayant joué ≥ 60 s / visiteurs ayant chargé le jeu
```

**Pondération :**

```text
Q = 35 % fidélisation
  + 25 % durée médiane
  + 25 % approbation (Wilson)
  + 15 % taux de jeu significatif
```

### 7.3 Correction de confiance (métriques hors votes)

L'approbation est déjà corrigée par Wilson. Les autres métriques de qualité
sont ramenées vers la valeur neutre selon la taille de leur propre
échantillon :

```text
confiance = échantillon / (échantillon + constante)
valeur corrigée = neutre + confiance × (observée − neutre)
```

```text
fidélisation → visiteurs éligibles de la cohorte
sessions     → sessions valides
engagement   → chargements
```

La valeur neutre est la moyenne globale observée sur l'ensemble des jeux
(prior empirique), pas un 50 arbitraire.

### 7.4 Troisième axe : jury des pairs **[v2]**

En plus de la grandeur et de la qualité, un axe **peer** mesure le jugement
des autres développeurs. Précédent validant : Ludum Dare fonctionne sur ce
principe depuis des années.

**Mécanisme**

```text
À l'inscription, le développeur doit :
  1. jouer aux 5 derniers jeux inscrits
     (temps actif minimal vérifié par le SDK, ex. 3-5 min chacun,
      ses propres jeux exclus) ;
  2. élire les 2 meilleurs.

Chaque jeu est donc présenté exactement 5 fois
(aux 5 inscrits suivants) : exposition uniforme par construction.
```

L'affectation est imposée (le juré ne choisit pas quels jeux il juge), et
« choisir 2 parmi 5 » produit 2×3 = 6 comparaisons par paires par juré —
les jugements relatifs sont plus fiables que les notes absolues.

**Score peer — barème sur 7 points**

```text
5 points max : élections reçues (1 point par juré ayant élu le jeu,
               5 présentations donc 5 au maximum)
2 points max : consensus (le développeur a élu des jeux également élus
               par d'autres jurés)
P = points obtenus / 7, ramené sur 0-100
```

La composante « élections reçues » est lissée par Wilson comme les votes
joueurs (§7.2), avec les poids de juré ci-dessous en dénominateur :

```text
élections = Wilson( Σ poids des jurés ayant élu le jeu
                  / Σ poids des jurés à qui le jeu a été présenté )
```

Valeur par défaut avant l'existence du jury : **2/7** (≈ 28,6/100),
identique pour tous les jeux — sans effet sur l'ordre du classement.

**Exception à la décroissance (§5)** : les cumuls peer ne décroissent PAS.
L'échantillon est fixe (5 présentations à vie, aucun flux entrant) — avec
décroissance, P s'évaporerait. C'est une évaluation à l'entrée, pas un flux.

**Poids d'un juré** (départ 1,0) :

```text
consensus   : monte si ses élus sont aussi élus par les autres jurés ;
              descend s'il contredit systématiquement le consensus
              ET les données comportementales
              (parade au vote stratégique inversé)
réseau      : les règles du §4 s'appliquent au compte juré
              (rafale de comptes même IP/ASN → poids effondré)
crédibilité : modulé par la confiance comportementale du propre jeu
              du juré — un compte au jeu sans joueurs réels pèse peu
```

**Risque assumé et parades.** « Les 5 derniers inscrits jugent » est
prévisible : un tricheur peut inscrire 5 faux comptes juste après son jeu
pour capturer son jury. Ce risque est accepté au MVP parce que (1) la
pression d'attaque est quasi nulle au lancement, (2) l'alternative
(tirage aléatoire dans une fenêtre de W jeux) divise le risque par W/5 mais
multiplie le délai de jugement par W/5 — le compromis est linéaire, sans
version « sûre et rapide », et (3) les trois pondérations de juré ci-dessus
rendent les faux jurés sans valeur : pour peser, un compte doit avoir un
réseau propre ET un jeu avec du trafic réel. Marquage automatique : jury
d'un jeu inscrit en rafale ou sur le même sous-réseau → revue manuelle
(§4.4). Si une manipulation est détectée ou quand le volume le permet,
passage à un tirage aléatoire fenêtré (simple changement de requête).

La doc publique décrit le principe (« chaque jeu est évalué par les
5 développeurs suivants, qui doivent y jouer avant de voter ») sans
détailler les pondérations anti-abus.

## 8. Agrégation **[v2]**

Pipeline complet :

```text
événements SDK
   ↓  poids visiteur (§4)
buckets à décroissance exponentielle (§5, unités brutes)
   ↓  correction Wilson / confiance (§7)
métriques corrigées
   ↓  normalisation 50 % absolu + 50 % percentile (§6)
sous-scores 0-100
   ↓  moyenne pondérée (§7.1, §7.2)          jury des pairs (§7.4)
G et Q                                        P
   ↓  Score = 0,30 × G + 0,55 × Q + 0,15 × P
score final 0-100
```

L'agrégation des sous-scores est une **moyenne pondérée** (compensatoire,
bornée, explicable en une phrase). La norme vectorielle (L2) est
explicitement rejetée : elle récompense les profils concentrés sur un seul
axe — précisément le profil du tricheur et du jeu populaire-médiocre.

Option v2+ : moyenne **géométrique** sur la famille Q uniquement, si les
données réelles montrent que la compensation pose problème (jeu énorme en
sessions mais nul en fidélisation trop bien classé). Elle punit les points
faibles et récompense l'équilibre. Pas au MVP.

## 9. Score final

```text
Score = 0,30 × G + 0,55 × Q + 0,15 × P
```

Le poids de P est volontairement modeste : alimenté par 5 jurés par jeu,
c'est l'axe le plus bruité et le plus capturable des trois au début — et le
plus utile au cold start (il a des données précisément quand Q n'en a pas).
Option v2+ : poids adaptatif — P domine pour un jeu neuf, Q prend le relais
quand la confiance comportementale monte.

Pendant la phase de test, le score v1 (proposition A : 50 % grandeur,
50 % discriminants, percentiles purs) est calculé en parallèle et conservé
en interne comme point de comparaison :

* stabilité du classement ;
* diversité des jeux visibles ;
* domination éventuelle des jeux populaires ;
* capacité à faire émerger de bons jeux peu connus ;
* sensibilité aux petits échantillons.

Seul le score v2 est affiché publiquement.

## 10. Visibilité des jeux peu mesurés

Le site distingue rang officiel et exposition :

```text
80 à 90 % des emplacements : classement officiel
10 à 20 % des emplacements : exploration de jeux récents / peu mesurés
```

Ces jeux sont identifiés : `Nouveau`, `Score provisoire`, `Confiance faible`.
Leur rang officiel n'est pas artificiellement modifié.

**Piste v2+ : Thompson sampling.** Chaque jeu reçoit une distribution
d'incertitude sur sa qualité (large si peu de données). Les emplacements de
découverte sont attribués par tirage dans ces distributions : les jeux
incertains-mais-prometteurs remontent proportionnellement à leur probabilité
d'être bons, et l'exploration s'éteint d'elle-même quand les données
arrivent. Remplace le quota fixe et ses seuils. Le classement officiel,
lui, reste déterministe.

## 11. Architecture technique

Inchangée par rapport à la v1.

**ClickHouse** — données volumineuses : événements d'activité, sessions,
visiteurs anonymes, agrégats par visiteur et par jour.

```text
rétention événements bruts    : 2 à 3 jours
rétention activité quotidienne : 40 à 45 jours
```

**PostgreSQL** — service web et données durables : jeux, développeurs, clés
SDK, votes, métriques calculées, scores, rangs, historique, cumuls
décroissants, données ASN agrégées.

```text
SDK JavaScript
      ↓
API TypeScript (Fastify)          ← résolution ASN, poids visiteur
      ↓
ClickHouse                        ← événements, sessions
      ↓ agrégation périodique (cron TypeScript)
PostgreSQL                        ← cumuls décroissants, scores, rangs
      ↓
site public et tableau de bord
```

Stack : SDK TypeScript · Node.js/Fastify · ClickHouse · PostgreSQL ·
cron TypeScript · Docker Compose · Caddy.
Kafka, Redis, Kubernetes et les microservices sont exclus du MVP.

**[v2]** Le tableau de bord développeur est un produit à part entière : le
SDK doit avoir de la valeur pour un dev **même sans le classement**
(analytics gratuit de qualité), c'est le levier principal d'adoption face au
problème d'œuf et de poule.

## 12. Critères d'acceptation

Le MVP est validé lorsque :

1. un développeur peut enregistrer un jeu ;
2. le SDK mesure le temps réellement actif ;
3. les événements sont stockés dans ClickHouse ;
4. les données sont agrégées par jeu, visiteur et jour ;
5. les anciennes données sont automatiquement purgées ;
6. les votes sont stockés dans PostgreSQL ;
7. les métriques sont calculées sur cumuls décroissants (×0,95/jour) ;
8. chaque métrique produit un sous-score 0-100 (50 % absolu + 50 % percentile) ;
9. les scores v1 et v2 sont calculés en parallèle ;
10. Wilson corrige l'approbation ; la confiance corrige les autres métriques ;
11. le classement est recalculé automatiquement ;
12. le dernier classement valide reste disponible en cas d'échec ;
13. les jeux récents peuvent recevoir une exposition exploratoire ;
14. la méthode de calcul est publiquement documentée ;
15. **[v2]** le poids anti-triche (préfixe × ASN × comportement) est appliqué
    au calcul des visiteurs uniques ;
16. **[v2]** les votes exigent un temps de jeu minimal ;
17. **[v2]** l'inscription exige de jouer aux 5 derniers jeux inscrits
    (temps vérifié SDK) et d'en élire 2 ;
18. **[v2]** le score peer est calculé avec pondération des jurés.

## 13. Paramètres configurables

À recalibrer avec les données réelles — la formule ne doit pas être figée
avant d'avoir observé plusieurs dizaines de jeux :

```text
durée minimale d'un visiteur qualifié        (30-60 s)
durée minimale d'une journée active          (60 s)
temps de jeu minimal pour voter              (60 s)
facteur de décroissance quotidien            (0,95)
ratio absolu / percentile                    (50/50)
bornes de référence des échelles absolues
constante de confiance (métriques hors votes)
valeur neutre (prior empirique global)
pondération grandeur / qualité               (35/65)
pondérations internes de G et Q
exposants du poids dégressif par préfixe     (0,9 / 0,85 / 0,75 / 0,65 / 0,5)
facteurs ASN                                 (1,0 / 0,3 / 0,1) — reporté v2+
cadence du pipeline de scoring, en secondes  (30 en dev/lancement)
seuil minimum d'éligibilité
pourcentage d'exposition exploratoire        (10-20 %)
délai de cohorte pour la fidélisation        (7 j)
nombre de jeux à juger à l'inscription       (5)
nombre de jeux à élire                       (2)
temps de jeu minimal par jeu jugé            (3-5 min)
bornes du poids de juré
pondération G / Q / P                        (30/55/15)
```

## 14. Pistes v2+ (hors MVP)

* moyenne géométrique sur la famille Q ;
* Thompson sampling pour les emplacements de découverte ;
* normalisation de la durée de session par genre de jeu ;
* détection d'anomalies statistiques avancée (distributions de durées,
  corrélation votes/sessions) ;
* liste VPN/Tor affinée (nœuds de sortie Tor : liste publique exacte) ;
* pondération G/Q/P adaptative (P domine pour les jeux neufs, Q prend le
  relais avec la confiance comportementale) ;
* jugements peer volontaires récurrents (badge « juré actif ») pour
  rafraîchir P au-delà des 5 présentations d'entrée ;
* tirage du jury aléatoire fenêtré si manipulation détectée, et K > 5
  présentations quand le rythme d'inscriptions le permet.
