import { existsSync } from "node:fs";
import { join } from "node:path";
import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod/v3";
import { listSymbols } from "./dashboard.js";
import { readPaperState, summarizeState } from "./paper.js";
import { formatStatus } from "./paper-cli.js";
import { DEFAULT_LIMITS, getCheckedPrice, normalizeSymbol, type PriceSource, type QualityLimits } from "./prices.js";

/**
 * Outil de LECTURE SEULE pour l'agent : il peut expliquer l'état du mode papier (capital, trades,
 * prix refusés) mais ne peut ni le lancer, ni l'arrêter, ni modifier la stratégie ou les fichiers.
 * Le LLM sert ici à surveiller et à rendre compte, pas à décider d'ordres.
 */
export function paperStatusActionProvider(dataDir = "data") {
  return customActionProvider({
    name: "get_paper_status",
    description:
      "Donne l'état du trading papier (argent fictif) pour un actif : capital, rendement, comparaison avec " +
      "acheter-garder, trades, frais, prix refusés, position. Lecture seule : ne lance ni n'arrête rien.",
    schema: z.object({ symbol: z.string().describe("Symbole de l'actif, ex. ETH") }) as any,
    invoke: async (args: { symbol: string }) => {
      const symbol = normalizeSymbol(args.symbol);
      const path = join(dataDir, `paper-${symbol}.json`);
      if (!existsSync(path)) {
        const known = listSymbols(dataDir);
        return (
          `Aucune donnée de trading papier pour ${symbol}. ` +
          (known.length ? `Symboles disponibles : ${known.join(", ")}.` : "Aucun suivi n'a encore été lancé (npm run paper).")
        );
      }
      return formatStatus(summarizeState(readPaperState(path)));
    },
  });
}

/** Outil `get_price` (lecture seule, ne dépense rien). Le schéma est typé `any` à la frontière AgentKit :
 *  AgentKit embarque zod 3 et les types profonds de zod font exploser tsc ; il reste validé à l'exécution. */
export function priceActionProvider(source: PriceSource, limits: QualityLimits = DEFAULT_LIMITS) {
  return customActionProvider({
    name: "get_price",
    description:
      "Donne le prix actuel en USD d'un actif crypto (ex. ETH, BTC, SOL) avec son horodatage. " +
      "Refuse les prix périmés ou trop incertains. Lecture seule.",
    schema: z.object({ symbol: z.string().describe("Symbole de l'actif, ex. ETH") }) as any,
    invoke: async (args: { symbol: string }) => {
      const q = await getCheckedPrice(source, args.symbol, limits);
      return (
        `${q.symbol}/USD = ${q.priceUsd.toFixed(2)} ` +
        `(±${q.confidenceUsd.toFixed(2)}, publié ${q.publishedAt.toISOString()}, source ${q.source})`
      );
    },
  });
}
