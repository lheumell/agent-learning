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

## Ta règle d'entrée : ce qui est testable

Description donnée : positions **dans les deux sens**, en **spot avec marge**, ouvertes **après une baisse (achat du creux)**, **sur une cassure**, ou **au feeling / sur une actu**, avec une prise de gain de **3 à 10 %**. Les seuils exacts ne sont pas connus.

- **Testable, traduit en code** (`src/entries.ts`) : « achat après une baisse » (`dip` : achat quand le prix est X % sous le plus haut des N barres précédentes, vente à découvert quand il est X % au-dessus du plus bas) et « cassure d'un niveau » (`breakout` : achat quand le prix dépasse le plus haut des N barres précédentes, vente à découvert sous le plus bas).
- **Non testable :** « au feeling, une actu ou un tweet ». Sans règle chiffrée, aucun backtest n'est possible. Si c'était la part principale de vos décisions, ce simulateur ne peut pas la juger.
- Ces deux règles sont **des traductions, pas votre règle exacte**. Un résultat ne vaut que pour la traduction testée.

Chaque règle est comparée à des **entrées au hasard de même fréquence, avec exactement les mêmes sorties** (prise de gain, stop ou réinjection, levier). Si une règle ne fait pas mieux que le hasard dans ces conditions, elle n'a pas d'avantage d'entrée : ce qui reste dans les résultats vient du marché et de la structure de risque.

Cas témoins (le test doit savoir dire oui, non et « à l'envers », sinon il ne prouve rien). Sorties à risque borné, levier 5×, marge 10 %, prise de gain 5 % (3 % pour le marché qui revient à la moyenne) :

| Marché simulé | Règle | Percentile moyen parmi les entrées au hasard | Lecture |
|---|---|---|---|
| Revient à la moyenne | achat après une baisse | **100 %** | détecte l'avantage |
| À tendances persistantes | cassure | **90 %** (médiane +42,9 % contre −19,0 %) | détecte l'avantage |
| À tendances persistantes | achat après une baisse | **9 %** (≤ 5 % sur la moitié des trajectoires) | pire que le hasard : règle inadaptée |
| Marche aléatoire (aucun avantage possible) | achat après une baisse | 53 % | indiscernable du hasard |
| Marche aléatoire | cassure | 55 % | indiscernable du hasard |

50 % = aucun avantage. Les deux règles sont donc de bonnes traductions de ce qu'elles veulent capter : l'outil les distingue du hasard quand l'avantage existe, et ne voit rien quand il n'existe pas.

### Procédure sur vos vrais prix (à suivre dans cet ordre)

1. Récupérer le plus d'historique possible, sur plusieurs régimes : `npm run history -- --days 1095` (trois ans).
2. Décider **maintenant**, avant de regarder le moindre résultat, d'un petit nombre de variantes (par exemple : `dip` avec N = 48 et X = 4 %, `breakout` avec N = 48 ; un seul couple de sorties). **Chaque variante essayée en plus augmente la chance de trouver un faux positif.**
3. Travailler sans la fin des données :

```bash
npm run entry -- --rule dip      --csv data/history/FICHIER.csv --holdout 0.2 --lookback 48 --drop 0.04 --tp 0.05 --stake 0.1 --leverage 5
npm run entry -- --rule breakout --csv data/history/FICHIER.csv --holdout 0.2 --lookback 48 --tp 0.05 --stake 0.1 --leverage 5
```

4. Seulement si une règle bat nettement le hasard (percentile moyen élevé **et** plusieurs fenêtres indépendantes), l'évaluer **une seule fois** sur la période réservée : même commande avec `--final` à la place de `--holdout`. Chaque regard supplémentaire est compté.
5. Si elle passe, la suivre en mode papier plusieurs semaines avant d'engager quoi que ce soit.

Limites propres à ce test : les fenêtres de vrais prix **se recouvrent** (elles ne sont pas des preuves indépendantes) ; trois ans d'une seule paire restent peu ; les intérêts d'emprunt de la marge et les frais de financement ne sont pas modélisés ; seuls les prix de clôture sont vus.

### Lire un résultat sans se tromper

Un percentile élevé sur un seul fichier ne suffit pas. Les pièges, dans l'ordre où ils apparaissent :

1. **Une seule trajectoire est fragile.** Les pourcentages comme « 100 % des trajectoires » n'ont aucun sens quand il n'y en a qu'une.
2. **Comparaisons multiples.** Deux règles × deux structures de sortie = quatre comparaisons sur les mêmes données. Sous l'hypothèse « aucun avantage », la probabilité qu'au moins une atteigne le 91e percentile est de **31 %** (1 − 0,91⁴). Le meilleur de plusieurs résultats est presque toujours flatteur.
3. **Les mêmes entrées doivent donner des verdicts compatibles.** Une vraie qualité d'entrée devrait aider quelle que soit la sortie. Un 41 % avec une structure de sortie et un 91 % avec l'autre indique plutôt du bruit, ou l'effet d'épisodes particuliers sur la manière dont les stops se déclenchent.
4. **La régularité dans le temps.** `--blocks 4` évalue 4 périodes consécutives, sans recouvrement, séparément. Avec un avantage réel (marché simulé qui revient à la moyenne) : 100 % · 100 % · 100 % · 100 %. Sans avantage (marche aléatoire simulée) : **43 % · 55 % · 88 % · 10 %**, moyenne 49 %. Sur du hasard pur, un bloc sur quatre peut donc sembler excellent.
5. **Le financement.** En spot avec marge, ou sur un perpétuel, chaque heure de position coûte. `--financing` le prélève sur la marge ; à régler d'après le barème de votre plateforme. Un avantage qui disparaît avec un coût réaliste n'en est pas un.
6. **Les variations extrêmes.** `--blocks` et `--holdout` affichent la plus forte variation sur une barre. Un stop placé à −10 % ne protège pas d'une chute de −20 % en une heure, ni d'un trou dans les données : la position est liquidée directement. Un « au moins une liquidation » à 100 % malgré un stop vient de là.

**Fixez vos critères avant de lancer les vérifications**, pas après. Exemple de critères pour un candidat : percentile moyen par bloc ≥ 75 %, au moins 3 blocs sur 4 ≥ 60 %, et un résultat qui reste supérieur au hasard avec un financement pessimiste. Si les critères ne sont pas remplis, c'est une absence de preuve : on ne consomme pas la période réservée (`--final`).

```bash
npm run entry -- --rule dip --csv data/history/FICHIER.csv --holdout 0.2 --blocks 4 --lookback 48 --drop 0.04 --tp 0.05 --stake 0.1 --leverage 5 --policy bounded
npm run entry -- --rule dip --csv data/history/FICHIER.csv --holdout 0.2 --lookback 48 --drop 0.04 --tp 0.05 --stake 0.1 --leverage 5 --policy bounded --financing 0.00001
npm run entry -- --rule dip --csv data/history/FICHIER.csv --holdout 0.2 --lookback 48 --drop 0.04 --tp 0.05 --stake 0.1 --leverage 5 --policy bounded --financing 0.00003
npm run entry -- --rule dip --csv data/history/FICHIER.csv --holdout 0.2 --lookback 48 --drop 0.04 --tp 0.05 --stake 0.1 --leverage 5 --policy bounded --financing 0.0001
```

(0,00001 par heure = 0,001 % du notionnel par heure, environ 0,024 % par jour ; 0,0001 = environ 0,24 % par jour. Ce sont des ordres de grandeur pour la sensibilité, pas le tarif d'une plateforme.)

## Limites du simulateur

- **Les premiers résultats de ce document (`npm run ruin`) utilisent des entrées sans avantage.** Si votre règle d'entrée en a un, la conclusion change pour *votre* stratégie : c'est ce que teste `npm run entry` (section précédente).
- **Seuls les prix de clôture sont vus** : les mèches qui déclenchent une liquidation réelle sont invisibles. Le risque réel est plus élevé.
- Financement : ignoré par défaut (`--financing` pour le prendre en compte). Pas de glissement, marge de maintenance générique.
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
