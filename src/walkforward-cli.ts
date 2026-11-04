import { parseFlags } from "./cli-utils.js";
import { loadCsvPrices, syntheticPrices } from "./simulate.js";
import { DEFAULT_GRID, walkForward, type WalkForwardResult } from "./walkforward.js";

export const WALKFORWARD_USAGE = `Usage : npm run walkforward -- [options]
  --csv fichier.csv      prix réels (colonne "close" ou dernière colonne)
  --seeds N              N séries simulées (défaut 1)    --n 2000  barres par série
  --drift 0  --vol 0.01  paramètres de la simulation (par barre)
  --train 500            barres d'entraînement par fenêtre
  --test 250             barres de test par fenêtre
  --fee 0.001  --slippage 0.0005`;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)} %`;

export function walkforwardCommand(args: string[], log: (s: string) => void = console.log) {
  if (args.includes("--help")) return log(WALKFORWARD_USAGE);
  const f = parseFlags(args);
  const num = (k: string, d: number) => {
    const v = f[k] === undefined ? d : Number(f[k]);
    if (!Number.isFinite(v)) throw new Error(`--${k} doit être un nombre`);
    return v;
  };
  const wf = {
    trainBars: num("train", 500),
    testBars: num("test", 250),
    grid: DEFAULT_GRID,
    exec: { feeRate: num("fee", 0.001), slippageRate: num("slippage", 0.0005) },
  };

  if (f.csv) return log(formatSingle(walkForward(loadCsvPrices(f.csv), wf), wf.trainBars, wf.testBars));

  const seeds = Math.max(1, Math.floor(num("seeds", 1)));
  const n = num("n", 2000);
  const drift = num("drift", 0);
  const vol = num("vol", 0.01);
  const results: WalkForwardResult[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    results.push(walkForward(syntheticPrices({ n, seed, drift, vol }), wf));
  }
  if (seeds === 1) {
    return log(formatSingle(results[0], wf.trainBars, wf.testBars) + `\n(série simulée seed=1, n=${n}, drift=${drift}, vol=${vol})`);
  }

  const share = (pred: (r: WalkForwardResult) => boolean) => `${((results.filter(pred).length / seeds) * 100).toFixed(0)} %`;
  log(
    [
      `Walk-forward sur ${seeds} séries simulées (n=${n}, drift=${drift}, vol=${vol}, entraînement ${wf.trainBars} / test ${wf.testBars}, ${results[0].folds.length} fenêtres, ${DEFAULT_GRID.length} jeux de paramètres, frais=${wf.exec.feeRate}, slippage=${wf.exec.slippageRate})`,
      ``,
      `  Rendement pour 100 barres (médiane) :`,
      `    entraînement, meilleurs paramètres (optimiste) : ${pct(median(results.map((r) => r.meanIsPer100)))}`,
      `    test, mêmes paramètres, données jamais vues    : ${pct(median(results.map((r) => r.meanOosPer100)))}`,
      ``,
      `  Rendement composé sur toutes les fenêtres de test (médiane) :`,
      `    paramètres optimisés : ${pct(median(results.map((r) => r.oosCompoundedPct)))}`,
      `    paramètres fixes 10/30 : ${pct(median(results.map((r) => r.fixedCompoundedPct)))}`,
      `    acheter-garder        : ${pct(median(results.map((r) => r.oosBuyHoldCompoundedPct)))}`,
      ``,
      `  Séries où les paramètres optimisés font mieux que les fixes : ${share((r) => r.oosCompoundedPct > r.fixedCompoundedPct)}`,
      `  Séries où l'optimisé bat acheter-garder                     : ${share((r) => r.oosCompoundedPct > r.oosBuyHoldCompoundedPct)}`,
      `  Séries rentables sur les données de test                    : ${share((r) => r.oosCompoundedPct > 0)}`,
    ].join("\n"),
  );
}

function formatSingle(r: WalkForwardResult, train: number, test: number): string {
  const rows = r.folds.map(
    (f) =>
      `  ${String(f.index + 1).padStart(2)}  ${String(f.params.fast).padStart(2)}/${String(f.params.slow).padEnd(3)}  ` +
      `${pct(f.isReturnPct).padStart(10)}  ${pct(f.oosReturnPct).padStart(10)}  ${pct(f.fixedOosReturnPct).padStart(10)}  ${pct(f.oosBuyHoldPct).padStart(10)}`,
  );
  return [
    `Walk-forward (entraînement ${train} / test ${test})`,
    `  #   SMA     entraîn.      test     fixe 10/30   ach.-garder`,
    ...rows,
    ``,
    `  Par 100 barres : entraînement ${pct(r.meanIsPer100)} → test ${pct(r.meanOosPer100)}`,
    `  Composé sur les fenêtres de test : optimisé ${pct(r.oosCompoundedPct)} · fixe ${pct(r.fixedCompoundedPct)} · acheter-garder ${pct(r.oosBuyHoldCompoundedPct)}`,
    `  Fenêtres de test positives : ${r.positiveFolds}/${r.folds.length}`,
  ].join("\n");
}
