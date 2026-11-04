import { parseFlags } from "./cli-utils.js";
import { splitHoldout } from "./holdout.js";
import { loadCsvPrices, syntheticPrices } from "./simulate.js";
import { parseStrategyName, walkForwardSetup } from "./strategies.js";
import { walkForward, type WalkForwardResult } from "./walkforward.js";

export const WALKFORWARD_USAGE = `Usage : npm run walkforward -- [options]
  --csv fichier.csv      prix réels (colonne "close" ou dernière colonne)
  --seeds N              N séries simulées (défaut 1)    --n 2000  barres par série
  --model gbm|ou         simulation : marche aléatoire (défaut) ou retour à la moyenne (--theta 0.05)
  --drift 0  --vol 0.01  paramètres de la simulation (par barre)
  --strategy sma|zrev    famille de stratégie (défaut sma)
  --train 500            barres d'entraînement par fenêtre
  --test 250             barres de test par fenêtre
  --fee 0.001  --slippage 0.0005
  --fee-sweep            refait l'analyse avec des frais de 0 %, 0,1 %, 0,3 % et 0,6 %
  --holdout 0.2          met de côté les 20 % finaux, non utilisés ici (voir : npm run holdout)`;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)} %`;
export const FEE_LEVELS = [0, 0.001, 0.003, 0.006];

export function walkforwardCommand(args: string[], log: (s: string) => void = console.log) {
  if (args.includes("--help")) return log(WALKFORWARD_USAGE);
  const f = parseFlags(args, ["fee-sweep"]);
  const num = (k: string, d: number) => {
    const v = f[k] === undefined ? d : Number(f[k]);
    if (!Number.isFinite(v)) throw new Error(`--${k} doit être un nombre`);
    return v;
  };
  const name = parseStrategyName(f.strategy);
  const setup = walkForwardSetup(name);
  const train = num("train", 500);
  const test = num("test", 250);
  const slippage = num("slippage", 0.0005);
  const run = (prices: number[], fee: number) =>
    walkForward(prices, { trainBars: train, testBars: test, ...setup, exec: { feeRate: fee, slippageRate: slippage } });
  const fee = num("fee", 0.001);

  // --- séries : CSV ou simulation
  let series: number[][];
  let origin: string;
  let note = "";
  const holdout = f.holdout === undefined ? undefined : num("holdout", 0);
  if (f.csv) {
    let prices = loadCsvPrices(f.csv);
    if (holdout !== undefined) {
      const sp = splitHoldout(prices, holdout);
      prices = sp.dev;
      note = `Période réservée : ${sp.holdout.length} barres (${(holdout * 100).toFixed(0)} %) NON utilisées ici. À évaluer une seule fois : npm run holdout`;
    }
    series = [prices];
    origin = f.csv;
  } else {
    const seeds = Math.max(1, Math.floor(num("seeds", 1)));
    const n = num("n", 2000);
    const model = f.model ?? "gbm";
    const opts = { n, drift: num("drift", 0), vol: num("vol", 0.01), model: model as "gbm" | "ou", theta: num("theta", 0.05) };
    series = Array.from({ length: seeds }, (_, i) => {
      const p = syntheticPrices({ ...opts, seed: i + 1 });
      return holdout === undefined ? p : splitHoldout(p, holdout).dev;
    });
    origin = `${seeds} série(s) simulée(s) · modèle ${model} · n=${n}`;
  }
  const head = `[${name}] ${origin}`;

  if (f["fee-sweep"] === "true") {
    log(`${head}\nSensibilité aux frais (slippage ${slippage}), rendement composé sur les fenêtres de test${series.length > 1 ? " (médiane)" : ""} :`);
    log(`  frais     optimisé     fixe        acheter-garder`);
    for (const fe of FEE_LEVELS) {
      const rs = series.map((p) => run(p, fe));
      const m = (g: (r: WalkForwardResult<any>) => number) => median(rs.map(g));
      log(
        `  ${(fe * 100).toFixed(1).padStart(4)} %   ${pct(m((r) => r.oosCompoundedPct)).padStart(9)}   ${pct(m((r) => r.fixedCompoundedPct)).padStart(9)}   ${pct(m((r) => r.oosBuyHoldCompoundedPct)).padStart(9)}`,
      );
    }
    if (note) log("\n" + note);
    return;
  }

  const results = series.map((p) => run(p, fee));
  if (results.length === 1) {
    log(formatSingle(results[0], train, test, name, setup.spec.label) + `\n(${head})`);
    if (note) log(note);
    return;
  }

  const n = results.length;
  const share = (pred: (r: WalkForwardResult<any>) => boolean) => `${((results.filter(pred).length / n) * 100).toFixed(0)} %`;
  log(
    [
      `Walk-forward [${name}] sur ${origin} (entraînement ${train} / test ${test}, ${results[0].folds.length} fenêtres, ${setup.grid.length} jeux de paramètres, frais=${fee}, slippage=${slippage})`,
      ``,
      `  Rendement pour 100 barres (médiane) :`,
      `    entraînement, meilleurs paramètres (optimiste) : ${pct(median(results.map((r) => r.meanIsPer100)))}`,
      `    test, mêmes paramètres, données jamais vues    : ${pct(median(results.map((r) => r.meanOosPer100)))}`,
      ``,
      `  Rendement composé sur toutes les fenêtres de test (médiane) :`,
      `    paramètres optimisés : ${pct(median(results.map((r) => r.oosCompoundedPct)))}`,
      `    paramètres fixes      : ${pct(median(results.map((r) => r.fixedCompoundedPct)))}`,
      `    acheter-garder        : ${pct(median(results.map((r) => r.oosBuyHoldCompoundedPct)))}`,
      ``,
      `  Séries où les paramètres optimisés font mieux que les fixes : ${share((r) => r.oosCompoundedPct > r.fixedCompoundedPct)}`,
      `  Séries où l'optimisé bat acheter-garder                     : ${share((r) => r.oosCompoundedPct > r.oosBuyHoldCompoundedPct)}`,
      `  Séries rentables sur les données de test                    : ${share((r) => r.oosCompoundedPct > 0)}`,
    ].join("\n"),
  );
  if (note) log("\n" + note);
}

function formatSingle(r: WalkForwardResult<any>, train: number, test: number, name: string, label: (p: any) => string): string {
  const rows = r.folds.map(
    (f) =>
      `  ${String(f.index + 1).padStart(2)}  ${label(f.params).padEnd(18)}  ` +
      `${pct(f.isReturnPct).padStart(10)}  ${pct(f.oosReturnPct).padStart(10)}  ${pct(f.fixedOosReturnPct).padStart(10)}  ${pct(f.oosBuyHoldPct).padStart(10)}`,
  );
  return [
    `Walk-forward (entraînement ${train} / test ${test}) [${name}]`,
    `  #   paramètres           entraîn.      test        fixe   ach.-garder`,
    ...rows,
    ``,
    `  Par 100 barres : entraînement ${pct(r.meanIsPer100)} → test ${pct(r.meanOosPer100)}`,
    `  Composé sur les fenêtres de test : optimisé ${pct(r.oosCompoundedPct)} · fixe ${pct(r.fixedCompoundedPct)} · acheter-garder ${pct(r.oosBuyHoldCompoundedPct)}`,
    `  Fenêtres de test positives : ${r.positiveFolds}/${r.folds.length}`,
  ].join("\n");
}
