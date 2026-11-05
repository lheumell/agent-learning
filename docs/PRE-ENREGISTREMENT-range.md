# Protocole fixé d'avance : achat après une baisse, situation « marché sans tendance »

Ce document est rédigé et committé **avant** que ce protocole soit exécuté. La date qui compte est celle de son premier commit dans l'historique git. Il ne contient aucun résultat.

## Hypothèse

Dans un marché sans tendance, acheter après une baisse de 4 % sous le plus haut des 48 dernières barres (et vendre à découvert après une hausse de 4 % au-dessus du plus bas des 48 dernières barres) :
1. fait mieux que des entrées au hasard **soumises au même filtre** ;
2. reste positif **net de financement** ;
3. fait mieux que **ne rien faire** et que **garder l'actif**.

## Paramètres figés (aucun ne sera modifié après avoir vu un résultat)

| Élément | Valeur |
|---|---|
| Règle | `dip`, `--lookback 48`, `--drop 0.04`, les deux sens |
| Situation | `--gate range` : ratio d'efficacité de Kaufman sur 48 barres ≤ 0,12 (valeurs par défaut, non optimisées) |
| Sortie | prise de gain 5 %, **risque borné** (stop à la moitié de la distance de liquidation), aucune réinjection |
| Taille | marge 10 % du capital, levier 5× (exposition notionnelle 50 %) |
| Coûts | frais 0,05 % par côté, financement 0,001 % par barre (`--financing 0.00001`) |
| Données | ETH-USD et BTC-USD, bougies d'1 h, 2023-11-06 → 2026-11-05 |
| Découpage | 20 % finaux réservés et **non utilisés** (`--holdout 0.2`) ; le reste en 4 blocs consécutifs sans recouvrement (`--blocks 4`) |

## Commandes exactes

```bash
npm run entry -- --rule dip --csv data/history/ETH-USD-3600-2023-11-06-2026-11-05.csv --holdout 0.2 --blocks 4 --gate range --lookback 48 --drop 0.04 --tp 0.05 --stake 0.1 --leverage 5 --policy bounded --financing 0.00001 --verdict
npm run entry -- --rule dip --csv data/history/BTC-USD-3600-2023-11-06-2026-11-05.csv --holdout 0.2 --blocks 4 --gate range --lookback 48 --drop 0.04 --tp 0.05 --stake 0.1 --leverage 5 --policy bounded --financing 0.00001 --verdict
```

## Critères de réussite (appliqués automatiquement par `--verdict`, pour chaque actif)

1. Percentile moyen de la règle contre le hasard **filtré** ≥ **65 %**.
2. Au moins **15 positions** par trajectoire (médiane) : en dessous, le test manque de données et ne peut pas réussir.
3. Capital final médian **> 0 %**.
4. Capital final médian **> garder l'actif** sur la même période.

**Réussite globale : les quatre critères remplis sur l'ETH ET sur le BTC.** Un seul actif ne suffit pas.

## Conséquences

- **Échec** : cette règle, dans cette situation, n'est pas validée. **Aucune variante** n'est essayée sur ces données (autre fenêtre, autre seuil, autre baisse, autre levier, autre filtre). Toute nouvelle idée fait l'objet d'un nouveau protocole écrit avant.
- **Réussite** : c'est un **indice**, pas une preuve (voir ci-dessous). Les étapes suivantes, dans cet ordre : évaluer **une seule fois** la période réservée de chaque actif (`--final`), puis suivre la règle en temps réel plusieurs semaines avant d'engager quoi que ce soit.
- Dans tous les cas, la période réservée n'est **pas** ouverte avant que les quatre critères soient remplis sur les deux actifs.

## Limites reconnues d'avance

- **Ce protocole n'est pas parfaitement à l'aveugle.** Les résultats sans filtre ont déjà été vus (percentile 71 % sur l'ETH, 62 % sur le BTC) avant de choisir la situation. Le choix de « marché sans tendance » repose sur une raison théorique (retour à la moyenne), mais un succès restera suggestif et non concluant.
- Le financement est une hypothèse (0,001 % par barre ≈ 0,024 % par jour, sur le notionnel) : le taux réel de la plateforme n'est pas connu.
- Seuls les prix de clôture sont vus : les mèches et les liquidations intrabarres sont sous-estimées.
- Trois ans, deux actifs corrélés entre eux : peu de régimes indépendants.
- Le filtre réduit le nombre d'entrées : un résultat plus bruité, pas moins.
- Non testé : la part « au feeling, une actu ou un tweet » de la méthode initiale, la réinjection, les autres situations.
