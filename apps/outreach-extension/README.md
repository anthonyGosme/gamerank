# WebGameRank Outreach Importer

Prototype Manifest V3 pour importer les publications `[PC] (Web)` chargées sur
`r/playmygame`. Il ne contacte aucun serveur Gamerank et n'envoie aucun e-mail :
le résultat est téléchargé localement au format JSON.

## Installation dans Chrome

1. Ouvrir `chrome://extensions`.
2. Activer **Mode développeur**.
3. Cliquer sur **Charger l'extension non empaquetée**.
4. Sélectionner le dossier `apps/outreach-extension`.
5. Ouvrir ou recharger la page filtrée :
   `https://www.reddit.com/r/playmygame/?f=flair_name%3A%22%5BPC%5D%20(Web)%22`.
6. Ouvrir l'extension puis cliquer sur **Charger et importer tous les posts**.
7. Télécharger `candidates.json`.

L'import complet revient en haut de la page, la fait défiler automatiquement et
mémorise les posts au fur et à mesure, y compris lorsque Reddit retire les
anciens éléments du DOM. La position de départ est restaurée à la fin.
L'import vise au maximum 200 publications et possède une limite de sécurité de
3 minutes.

Le bouton **Importer seulement les posts visibles** reste disponible pour un
diagnostic rapide.

L'extension demande uniquement l'accès aux pages
`https://www.reddit.com/r/playmygame/*`.

## Données exportées

Chaque publication contient :

- identifiant et permalink Reddit ;
- titre, auteur, date et flair lorsque disponibles ;
- texte visible de la carte ;
- liens externes candidats, classés mais non sélectionnés définitivement ;
- méthode de détection du flair ;
- date de capture.

Le fichier contient aussi des diagnostics : cartes inspectées, doublons,
publications rejetées et publications sans lien candidat.

## Validation du prototype

Tester environ 20 publications et noter :

| Mesure | Cible |
|---|---:|
| Bons posts détectés | ≥ 95 % |
| Vrai lien du jeu présent dans les candidats | ≥ 90 % |
| Doublons exportés | 0 |
| Temps d'import | < 2 min |
| CAPTCHA ou blocage déclenché par l'action | 0 |

Ce prototype ne choisit pas encore automatiquement le vrai lien du jeu. Il
attribue seulement un score aux liens afin de préparer l'étape suivante.

## Tests

Depuis la racine du dépôt :

```bash
npm test -w apps/outreach-extension
```
