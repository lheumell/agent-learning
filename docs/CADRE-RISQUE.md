# Prendre du risque sans faire n'importe quoi

Ce document répond à une question précise : peut-on bâtir une stratégie « petit gain, et on réinjecte du capital quand le prix approche de la liquidation » qui soit **fiable** ?

**Réponse courte : non, et ce n'est pas un défaut d'exécution, c'est la structure du pari.** Ce qu'on peut construire, c'est un cadre où une perte reste une perte *prévue*, bornée à l'avance, et pas une catastrophe. Ni l'un ni l'autre ne crée d'avantage sur le marché.

## Ce que mesure `npm run ruin`

Le simulateur (`src/leverage.ts`) compare deux façons de gérer une position à levier, avec des **entrées sans aucun avantage** (on ouvre dès qu'on est à plat), pour isoler l'effet de la structure de risque :

- **Réinjecte à fond** : prise de gain de 1 %, et quand le prix s'approche de la liquidation, on injecte tout le capital libre pour la repousser.
- **Risque borné** : même prise de gain, mais un stop prévu à l'avance (la moitié de la distance de liquidation), aucune réinjection.

300 trajectoires de marche aléatoire de 4 000 barres (volatilité horaire d'ETH ≈ 0,7 %), capital 10 000, marge à l'ouverture = part du capital, frais 0,05 % par côté :

| Scénario (exposition notionnelle) | Politique | Positions gagnantes | Capital final médian | Perte ≥ 90 % | Au moins une liquidation | Capital engagé au pire |
|---|---|---|---|---|---|---|
| **B** : marge 10 %, levier 10× (100 % du capital) | réinjecte | **97,8 %** | −10,0 % | 0 % | 0 % | **100 %** |
| | borné | 79,5 % | −19,4 % | 0 % | 0 % | 10 % |
| **C** : marge 20 %, levier 10× (200 % du capital) | réinjecte | **97,5 %** | −34,2 % | **20,7 %** | **16 %** | **100 %** |
| | borné | 79,5 % | −44,7 % | 1,7 % | 0 % | 20 % |

Marché haussier simulé (scénario B, +0,0001 par barre) : réinjecter donne **+31,9 %** en médiane, le risque borné +7,0 %, et **garder simplement le capital sans levier +41,8 %**. Marché baissier : −37,9 % et −41,8 % (garder : −36,3 %).

Ce que ça montre :

1. **Réinjecter produit presque uniquement des positions gagnantes (96 à 99 %) quel que soit le marché, y compris quand il n'y a aucun avantage.** C'est la signature statistique du « ça marchait » : une longue série de petits gains, et une queue de pertes rare mais énorme. Une série de réussites ne prouve ni le talent ni un risque faible.
2. **Au pire moment, 100 % du capital est dans la position.** Le « petit paquet » du départ devient tout. Le risque initial affiché n'est pas le risque réel.
3. **En marché plat ou baissier, au moins la moitié des trajectoires contiennent une position coincée pendant toute la durée autorisée** (2 000 barres) : le capital est immobilisé, et on ne gagne plus rien pendant ce temps. En marché haussier, la plus longue position dure 1 729 barres en médiane.
4. **Au-delà de 100 % d'exposition notionnelle, réinjecter ne protège plus de la ruine** : dans le scénario C, 20,7 % des trajectoires perdent 90 % ou plus, contre 1,7 % avec un stop. Un prix qui « saute » au-delà de la zone de réinjection est liquidé sans possibilité de réagir (testé).
5. **Dans un marché qui monte, tout semble marcher, et garder sans rien faire fait mieux.** Les gains d'une période haussière ne prouvent pas que la méthode a de la valeur.
6. **Le risque borné n'est pas plus rentable.** Sans avantage d'entrée, aucune structure de stop n'en crée un : il perd autant, voire davantage ici, parce qu'il fait beaucoup plus de trades donc paie plus de frais. Sa valeur est ailleurs : la perte maximale est **connue avant d'entrer**, et le capital n'est jamais immobilisé.

Reproduire :

```bash
npm run ruin -- --seeds 300 --stake 0.1 --leverage 10                 # scénario B
npm run ruin -- --seeds 300 --stake 0.2 --leverage 10                 # scénario C
npm run ruin -- --seeds 300 --stake 0.1 --leverage 10 --drift 0.0001  # marché haussier
npm run ruin -- --csv data/history/FICHIER.csv --stake 0.1 --leverage 10   # sur de vrais prix (fenêtres qui se recouvrent)
```

## Limites du simulateur

- **Entrées sans avantage.** Si votre règle d'entrée en a un, la conclusion change pour *votre* stratégie. Le simulateur ne peut pas le savoir : il faut tester votre vraie règle (walk-forward, période réservée, puis papier).
- **Seuls les prix de clôture sont vus** : les mèches qui déclenchent une liquidation réelle sont invisibles. Le risque réel est plus élevé.
- Pas de financement (funding), pas de glissement, marge de maintenance générique.
- Trajectoires simulées (marche aléatoire) : un vrai marché a des chocs, des tendances et des régimes.

## Cadre : pour qu'une perte soit de la malchance et pas une bêtise

Aucune règle ci-dessous ne rend le trading rentable. Elles garantissent qu'une perte reste **dans ce que vous aviez prévu**. À écrire **avant** de trader, pas pendant.

1. **Une enveloppe de jeu fixe**, séparée de l'épargne : un montant que vous acceptez de perdre **en entier** sans changer de vie. Elle ne se réalimente **qu'à date fixe** (par exemple une fois par mois), jamais en cours de route pour « se sauver ».
2. **Aucune réinjection.** Ajouter de la marge à une position qui perd est la décision qui transforme une perte bornée en perte totale.
3. **Exposition notionnelle ≤ enveloppe.** Au-delà, la ruine est possible même en réinjectant tout.
4. **Perte maximale par position décidée avant l'entrée** (par exemple 2 % de l'enveloppe), stop posé à l'ouverture, **jamais déplacé vers le bas**.
5. **Règle de pause :** si l'enveloppe perd 30 %, arrêt pendant 30 jours et revue écrite.
6. **Règle de retrait :** dès que l'enveloppe dépasse son niveau de départ, une part fixe du surplus (par exemple la moitié) sort **automatiquement** vers l'épargne ou un don. Cela verrouille les gains et empêche de les remettre en jeu.
7. **Un journal** : pour chaque position, la raison, la taille, le stop, le résultat. Chaque trimestre, comparer à « garder simplement », dans la même période.
8. **Une idée d'entrée se prouve avant de risquer quoi que ce soit** : walk-forward sur un an de vrais prix, période réservée évaluée une seule fois, puis mode papier plusieurs semaines. Sans preuve d'avantage, c'est un jeu : à traiter avec un budget de loisir, pas comme un revenu.

**Si une de ces règles a été violée, la perte n'est pas de la malchance.** Si toutes ont été respectées, c'est de la variance : elle était prévue.

Pour aider des personnes dans le besoin, des dons réguliers prélevés sur vos revenus ne dépendent pas du résultat d'un trade ; les gains de trading, eux, sont incertains et peuvent être négatifs.

Ceci n'est pas un conseil financier personnalisé : la situation de chacun est différente.
