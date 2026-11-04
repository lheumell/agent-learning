import { runBacktest, type BacktestResult } from "./backtest.js";
import { loadCsvPrices, syntheticPrices } from "./simulate.js";
import { SmaCrossover } from "./strategy.js";

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) throw new Error(`argument inattendu : ${args[i]}`);
    const key = args[i].slice(2);
    const val = args[i + 1];
    if (val === undefined || val.startsWith("--")) throw new Error(`--${key} attend une valeur`);
    out[key] = val;
    i++;
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} %`;

export const BACKTEST_USAGE = `Usage : npm run backtest -- [options]
  --csv fichier.csv     prix réels (colonne "close" ou dernière colonne)
  --seeds N             N séries simulées (défaut 1)   --n 1000  barres par série
  --drift 0  --vol 0.01 paramètres de la simulation (par barre)
  --fast 10  --slow 30  fenêtres de la moyenne mobile
  --fee 0.001  --slippage 0.0005`;

export function backtestCommand(args: string[], log: (s: string) => void = console.log) {
  if (args.includes("--help")) return log(BACKTEST_USAGE);
  const f = parseFlags(args);
  const num = (k: string, d: number) => {
    const v = f[k] === undefined ? d : Number(f[k]);
    if (!Number.isFinite(v)) throw new Error(`--${k} doit être un nombre`);
    return v;
  };
  const fast = num("fast", 10);
  const slow = num("slow", 30);
  const cfg = { feeRate: num("fee", 0.001), slippageRate: num("slippage", 0.0005) };
  const mk = () => new SmaCrossover(fast, slow);

  if (f.csv) {
    const r = runBacktest(loadCsvPrices(f.csv), mk(), cfg);
    return log(formatSingle(r));
  }

  const seeds = Math.max(1, Math.floor(num("seeds", 1)));
  const n = num("n", 1000);
  const drift = num("drift", 0);
  const vol = num("vol", 0.01);
  const results: BacktestResult[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    results.push(runBacktest(syntheticPrices({ n, seed, drift, vol }), mk(), cfg));
  }

  if (seeds === 1) return log(formatSingle(results[0]) + `\n(série simulée seed=1, n=${n}, drift=${drift}, vol=${vol})`);

  const beat = results.filter((r) => r.returnPct > r.buyHoldReturnPct).length;
  const profitable = results.filter((r) => r.returnPct > 0).length;
  log(
    [
      `${results[0].strategy} sur ${seeds} séries simulées (n=${n}, drift=${drift}, vol=${vol}, frais=${cfg.feeRate}, slippage=${cfg.slippageRate})`,
      `  rendement médian stratégie : ${pct(median(results.map((r) => r.returnPct)))}`,
      `  rendement médian acheter-garder : ${pct(median(results.map((r) => r.buyHoldReturnPct)))}`,
      `  stratégie bat acheter-garder : ${((beat / seeds) * 100).toFixed(0)} % des séries`,
      `  stratégie rentable : ${((profitable / seeds) * 100).toFixed(0)} % des séries`,
      `  drawdown max médian : ${median(results.map((r) => r.maxDrawdownPct)).toFixed(1)} %`,
      `  aller-retours médian : ${median(results.map((r) => r.roundTrips))}`,
      `  frais médians : ${median(results.map((r) => r.feesPaid)).toFixed(2)} USD`,
    ].join("\n"),
  );
}

function formatSingle(r: BacktestResult): string {
  return [
    `${r.strategy}`,
    `  capital final : ${r.finalEquity.toFixed(2)} USD (${pct(r.returnPct)})`,
    `  acheter-garder : ${pct(r.buyHoldReturnPct)}`,
    `  drawdown max : ${r.maxDrawdownPct.toFixed(1)} %`,
    `  aller-retours : ${r.roundTrips}${r.winRate === null ? "" : ` (gagnants : ${(r.winRate * 100).toFixed(0)} %)`}${r.openPosition ? ", position ouverte à la fin" : ""}`,
    `  frais payés : ${r.feesPaid.toFixed(2)} USD`,
  ].join("\n");
}
