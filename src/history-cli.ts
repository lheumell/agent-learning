import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseFlags } from "./cli-utils.js";
import {
  GRANULARITIES,
  candlesToCsv,
  fetchCandles,
  validateGranularity,
  validateProduct,
  type HistoryReport,
} from "./history.js";

export const HISTORY_USAGE = `Usage : npm run history -- [options]
  --product ETH-USD       paire Coinbase (défaut ETH-USD)
  --granularity 3600      secondes par bougie : ${GRANULARITIES.join(" | ")} (défaut 3600 = 1 h)
  --days 90               les N derniers jours (défaut 90) …
  --start 2025-01-01 --end 2025-07-01   … ou une plage explicite (UTC)
  --out data/history/x.csv   fichier de sortie (défaut : data/history/<PRODUIT>-<granularité>-<début>-<fin>.csv)
  --force                 écrase le fichier de sortie s'il existe
  --strict                échoue si des bougies manquent (sinon, avertit seulement)
Ensuite : npm run backtest -- --csv <fichier>   |   npm run walkforward -- --csv <fichier>`;

export interface HistoryDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  nowSec?: number;
}

function parseDate(label: string, raw: string): number {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(raw)) throw new Error(`--${label} : date attendue au format AAAA-MM-JJ (reçu "${raw}")`);
  const t = Date.parse(raw.includes("T") ? (raw.endsWith("Z") ? raw : raw + "Z") : raw + "T00:00:00Z");
  if (!Number.isFinite(t)) throw new Error(`--${label} : date invalide "${raw}"`);
  return t / 1000;
}

export function formatReport(r: HistoryReport, g: number): string {
  const lines = [
    `  ${r.candles} bougies de ${g} s · du ${r.first} au ${r.last} · ${r.requests} requête(s)`,
    r.missing === 0
      ? `  ✔ aucune bougie manquante`
      : `  ⚠ ${r.missing} bougie(s) manquante(s) sur ${r.expected} attendues (plus longue séquence : ${r.longestGap}). Premiers trous : ${r.gapStarts.join(", ")}`,
  ];
  if (r.duplicatesRemoved) lines.push(`  ${r.duplicatesRemoved} doublon(s) supprimé(s)`);
  if (r.droppedUnfinished) lines.push(`  ${r.droppedUnfinished} bougie en cours ignorée (son close n'est pas définitif)`);
  if (r.missing > 0) {
    lines.push(`  Le backtest traite chaque ligne comme une barre consécutive : des trous faussent les moyennes mobiles.`);
  }
  return lines.join("\n");
}

export async function historyCommand(args: string[], log: (s: string) => void = console.log, deps: HistoryDeps = {}) {
  if (args.includes("--help")) return log(HISTORY_USAGE);
  const f = parseFlags(args, ["force", "strict"]);
  const product = validateProduct(f.product ?? "ETH-USD");
  const g = validateGranularity(Number(f.granularity ?? 3600));
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);

  let start: number;
  let end: number;
  if (f.start || f.end) {
    if (f.days) throw new Error("--days est incompatible avec --start/--end");
    if (!f.start) throw new Error("--end demande aussi --start");
    start = parseDate("start", f.start);
    end = f.end ? parseDate("end", f.end) : nowSec;
  } else {
    const days = Number(f.days ?? 90);
    if (!Number.isFinite(days) || days <= 0) throw new Error("--days doit être un nombre positif");
    end = nowSec;
    start = end - days * 86400;
  }

  const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
  const out = f.out ?? `data/history/${product}-${g}-${day(start)}-${day(Math.min(end, nowSec))}.csv`;
  if (existsSync(out) && f.force !== "true") {
    throw new Error(`${out} existe déjà (utilisez --force pour l'écraser ou --out pour un autre nom)`);
  }

  log(`Téléchargement ${product} · bougies de ${g} s · ${day(start)} → ${day(Math.min(end, nowSec))}`);
  const { candles, report } = await fetchCandles({
    product,
    granularity: g,
    start,
    end,
    fetchFn: deps.fetchFn,
    sleep: deps.sleep,
    nowSec,
    onProgress: (d, t) => {
      if (t > 1 && (d === t || d % 10 === 0)) log(`  … ${d}/${t} requêtes`);
    },
  });

  log(formatReport(report, g));
  if (report.missing > 0 && f.strict === "true") {
    throw new Error(`--strict : ${report.missing} bougie(s) manquante(s), fichier non écrit`);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, candlesToCsv(candles));
  log(`\nÉcrit : ${out}`);
  log(`Essayez : npm run backtest -- --csv ${out}\n          npm run walkforward -- --csv ${out}`);
}
