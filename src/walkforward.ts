import { runBacktest } from "./backtest.js";
import { DEFAULT_EXECUTION, buyAndHoldEquity, type ExecutionConfig } from "./portfolio.js";
import { SmaCrossover } from "./strategy.js";

export interface ParamSet {
  fast: number;
  slow: number;
}

export interface WalkForwardConfig {
  /** Barres utilisées pour choisir les paramètres. */
  trainBars: number;
  /** Barres de test, jamais vues pendant le choix. */
  testBars: number;
  /** Décalage entre deux fenêtres (défaut : testBars, donc des tests contigus sans recouvrement). */
  stepBars?: number;
  /** Paramètres candidats. */
  grid: ParamSet[];
  /** Paramètres fixes de référence (défaut 10/30) : l'optimisation fait-elle mieux que ne rien optimiser ? */
  fixed?: ParamSet;
  exec?: Partial<ExecutionConfig>;
}

export interface Fold {
  index: number;
  trainStart: number;
  testStart: number;
  testEnd: number;
  params: ParamSet;
  /** Rendement sur la fenêtre d'entraînement avec les paramètres retenus (flatteur par construction). */
  isReturnPct: number;
  /** Rendement sur la fenêtre de test. C'est le seul chiffre qui compte. */
  oosReturnPct: number;
  oosBuyHoldPct: number;
  /** Rendement test avec les paramètres fixes, sur la même fenêtre. */
  fixedOosReturnPct: number;
  oosTrades: number;
}

export interface WalkForwardResult {
  folds: Fold[];
  /** Rendements de test enchaînés (composés). */
  oosCompoundedPct: number;
  oosBuyHoldCompoundedPct: number;
  fixedCompoundedPct: number;
  /** Rendement moyen ramené à 100 barres, pour comparer entraînement et test de longueurs différentes. */
  meanIsPer100: number;
  meanOosPer100: number;
  positiveFolds: number;
}

export const DEFAULT_GRID: ParamSet[] = (() => {
  const out: ParamSet[] = [];
  for (const fast of [3, 5, 8, 10, 15, 20]) {
    for (const slow of [20, 30, 50, 80, 100, 150]) if (fast < slow) out.push({ fast, slow });
  }
  return out;
})();

export const DEFAULT_FIXED: ParamSet = { fast: 10, slow: 30 };

/** Ramène un rendement (%) observé sur `bars` barres à un rendement pour 100 barres. */
export function per100(returnPct: number, bars: number): number {
  return ((1 + returnPct / 100) ** (100 / bars) - 1) * 100;
}

function validate(prices: number[], c: WalkForwardConfig) {
  if (!c.grid.length) throw new Error("grille de paramètres vide");
  const maxSlow = Math.max(...c.grid.map((g) => g.slow), (c.fixed ?? DEFAULT_FIXED).slow);
  if (c.trainBars < maxSlow + 50) throw new Error(`trainBars trop court : minimum ${maxSlow + 50} (plus grande fenêtre lente + 50)`);
  if (c.testBars < 30) throw new Error("testBars trop court : minimum 30");
  if ((c.stepBars ?? c.testBars) < 1) throw new Error("stepBars doit être >= 1");
  if (prices.length < c.trainBars + c.testBars) {
    throw new Error(`série trop courte : ${prices.length} barres, il en faut au moins ${c.trainBars + c.testBars}`);
  }
}

/**
 * Évalue des paramètres sur [from, to). La stratégie reçoit `slow` barres d'échauffement AVANT `from`
 * (passé uniquement) sans pouvoir trader pendant l'échauffement, pour ne pas perdre le début de la fenêtre.
 * Le capital repart à zéro position à chaque fenêtre : les fenêtres sont indépendantes.
 */
function evaluate(prices: number[], from: number, to: number, p: ParamSet, exec: Partial<ExecutionConfig>) {
  const start = Math.max(0, from - p.slow);
  const r = runBacktest(prices.slice(start, to), new SmaCrossover(p.fast, p.slow), exec);
  return { returnPct: r.returnPct, trades: r.trades.length };
}

const compound = (rs: number[]) => (rs.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function walkForward(prices: number[], config: WalkForwardConfig): WalkForwardResult {
  validate(prices, config);
  const exec = config.exec ?? {};
  const cfg = { ...DEFAULT_EXECUTION, ...exec };
  const step = config.stepBars ?? config.testBars;
  const fixed = config.fixed ?? DEFAULT_FIXED;
  const folds: Fold[] = [];

  for (let s = 0; s + config.trainBars + config.testBars <= prices.length; s += step) {
    const testStart = s + config.trainBars;
    const testEnd = testStart + config.testBars;

    // Choix des paramètres : uniquement avec prices[s, testStart). Rien après testStart n'est lu ici.
    let best = config.grid[0];
    let bestRet = -Infinity;
    for (const p of config.grid) {
      const ret = runBacktest(prices.slice(s, testStart), new SmaCrossover(p.fast, p.slow), exec).returnPct;
      if (ret > bestRet) {
        bestRet = ret;
        best = p;
      }
    }

    const oos = evaluate(prices, testStart, testEnd, best, exec);
    const fix = evaluate(prices, testStart, testEnd, fixed, exec);
    const bh = (buyAndHoldEquity(prices[testStart], prices[testEnd - 1], cfg) / cfg.initialCashUsd - 1) * 100;

    folds.push({
      index: folds.length,
      trainStart: s,
      testStart,
      testEnd,
      params: best,
      isReturnPct: bestRet,
      oosReturnPct: oos.returnPct,
      oosBuyHoldPct: bh,
      fixedOosReturnPct: fix.returnPct,
      oosTrades: oos.trades,
    });
  }

  return {
    folds,
    oosCompoundedPct: compound(folds.map((f) => f.oosReturnPct)),
    oosBuyHoldCompoundedPct: compound(folds.map((f) => f.oosBuyHoldPct)),
    fixedCompoundedPct: compound(folds.map((f) => f.fixedOosReturnPct)),
    meanIsPer100: mean(folds.map((f) => per100(f.isReturnPct, config.trainBars))),
    meanOosPer100: mean(folds.map((f) => per100(f.oosReturnPct, config.testBars))),
    positiveFolds: folds.filter((f) => f.oosReturnPct > 0).length,
  };
}
