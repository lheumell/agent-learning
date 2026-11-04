import { parseFlags } from "./cli-utils.js";
import { PaperTrader, runPaper, type PaperStatus } from "./paper.js";
import { CoinbaseSource } from "./prices.js";
import { SmaCrossover } from "./strategy.js";
import { normalizeSymbol } from "./prices.js";

export const PAPER_USAGE = `Usage : npm run paper -- [status] [options]
  --symbol ETH          actif suivi (défaut ETH)
  --interval 60         secondes entre deux prix (min. 5, défaut 60)
  --ticks N             s'arrête après N prix (défaut : tourne jusqu'à Ctrl+C)
  --fast 10 --slow 30   fenêtres de la moyenne mobile
  --capital 1000 --fee 0.001 --slippage 0.0005
  --reset               repart de zéro (efface l'état de ce symbole)
  status                affiche l'état sans rien lancer`;

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} %`;

export function formatStatus(s: PaperStatus): string {
  return [
    `${s.symbol} · ${s.strategy} · démarré ${s.startedAt}`,
    `  prix reçus : ${s.ticks} (sautés : ${s.skipped}) · dernier prix : ${s.lastPrice?.toFixed(2) ?? "—"}`,
    `  capital : ${s.equity.toFixed(2)} USD (${pct(s.returnPct)})` +
      (s.buyHoldReturnPct === null ? "" : ` · acheter-garder : ${pct(s.buyHoldReturnPct)}`),
    `  trades : ${s.trades} · aller-retours : ${s.roundTrips}` +
      (s.winRate === null ? "" : ` (gagnants : ${(s.winRate * 100).toFixed(0)} %)`) +
      (s.openPosition ? " · position ouverte" : ""),
    `  frais payés : ${s.feesPaid.toFixed(2)} USD · prochain ordre : ${s.pending}`,
  ].join("\n");
}

export async function paperCommand(args: string[], log: (s: string) => void = console.log) {
  if (args.includes("--help")) return log(PAPER_USAGE);
  const isStatus = args[0] === "status";
  const f = parseFlags(isStatus ? args.slice(1) : args, ["reset"]);
  const num = (k: string, d: number) => {
    const v = f[k] === undefined ? d : Number(f[k]);
    if (!Number.isFinite(v)) throw new Error(`--${k} doit être un nombre`);
    return v;
  };

  const symbol = normalizeSymbol(f.symbol ?? "ETH");
  const interval = num("interval", 60);
  if (interval < 5) throw new Error("--interval minimum : 5 secondes (ne martelez pas l'API publique)");
  const fast = num("fast", 10);
  const slow = num("slow", 30);

  const trader = PaperTrader.open({
    symbol,
    makeStrategy: () => new SmaCrossover(fast, slow),
    source: new CoinbaseSource(),
    exec: { initialCashUsd: num("capital", 1000), feeRate: num("fee", 0.001), slippageRate: num("slippage", 0.0005) },
    statePath: `data/paper-${symbol}.json`,
    journalPath: `data/paper-${symbol}.jsonl`,
    killSwitchPath: "data/STOP",
    reset: f.reset === "true",
  });

  if (isStatus) return log(formatStatus(trader.status()));

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    log("\nCtrl+C : arrêt après le tick en cours…");
  });
  log(`Mode PAPIER (aucun argent réel, aucune transaction) · ${symbol} · ${trader.status().strategy} · toutes les ${interval} s`);
  if (slow * interval > 3600) log(`ℹ Il faut ${slow} prix avant le premier signal (~${Math.round((slow * interval) / 60)} min).`);
  await runPaper(trader, {
    intervalSec: interval,
    maxTicks: f.ticks === undefined ? undefined : num("ticks", 0),
    log,
    shouldStop: () => stop,
  });
  log("\n" + formatStatus(trader.status()));
}
