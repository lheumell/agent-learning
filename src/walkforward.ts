import { runBacktest } from "./backtest.js";
import { DEFAULT_EXECUTION, buyAndHoldEquity, type ExecutionConfig } from "./portfolio.js";
import { SmaCrossover, ZScoreReversion, type Strategy } from "./strategy.js";

export interface ParamSet {
  fast: number;
  slow: number;
}

/** Décrit une famille de stratégies pour le walk-forward. */
export interface StrategySpec<P> {
  make: (p: P) => Strategy;
  /** Barres d'échauffement nécessaires avant la première décision. */
  warmup: (p: P) => number;
  label: (p: P) => string;
}

export const SMA_SPEC: StrategySpec<ParamSet> = {
  make: (p) => new SmaCrossover(p.fast, p.slow),
  warmup: (p) => p.slow,
  label: (p) => `SMA ${p.fast}/${p.slow}`,
};

export interface ZrevParams {
  window: number;
  entryZ: number;
  exitZ: number;
}

export const ZREV_SPEC: StrategySpec<ZrevParams> = {
  make: (p) => new ZScoreReversion(p.window, p.entryZ, p.exitZ),
  warmup: (p) => p.window,
  label: (p) => `ZREV ${p.window}/${p.entryZ}/${p.exitZ}`,
};

export const ZREV_GRID: ZrevParams[] = (() => {
  const out: ZrevParams[] = [];
  for (const window of [20, 50, 100]) {
    for (const entryZ of [1, 1.5, 2, 2.5]) {
      for (const exitZ of [-0.5, 0, 0.5]) out.push({ window, entryZ, exitZ });
    }
  }
  return out;
})();
export const ZREV_FIXED: ZrevParams = { window: 50, entryZ: 2, exitZ: 0 };

export interface WalkForwardConfig<P = ParamSet> {
  /** Barres utilisées pour choisir les paramètres. */
  trainBars: number;
  /** Barres de test, jamais vues pendant le choix. */
  testBars: number;
  /** Décalage entre deux fenêtres (défaut : testBars, donc des tests contigus sans recouvrement). */
  stepBars?: number;
  /** Paramètres candidats. */
  grid: P[];
  /** Paramètres fixes de référence (SMA : 10/30 par défaut) : l'optimisation fait-elle mieux que ne rien optimiser ? */
  fixed?: P;
  /** Famille de stratégies (défaut : croisement de moyennes mobiles). */
  spec?: StrategySpec<P>;
  exec?: Partial<ExecutionConfig>;
}

export interface Fold<P = ParamSet> {
  index: number;
  trainStart: number;
  testStart: number;
  testEnd: number;
  params: P;
  /** Rendement sur la fenêtre d'entraînement avec les paramètres retenus (flatteur par construction). */
  isReturnPct: number;
  /** Rendement sur la fenêtre de test. C'est le seul chiffre qui compte. */
  oosReturnPct: number;
  oosBuyHoldPct: number;
  /** Rendement test avec les paramètres fixes, sur la même fenêtre. */
  fixedOosReturnPct: number;
  oosTrades: number;
}

export interface WalkForwardResult<P = ParamSet> {
  folds: Fold<P>[];
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

function resolve<P>(c: WalkForwardConfig<P>): { spec: StrategySpec<P>; fixed: P } {
  const spec = (c.spec ?? (SMA_SPEC as unknown as StrategySpec<P>));
  const fixed = c.fixed ?? (c.spec ? undefined : (DEFAULT_FIXED as unknown as P));
  if (fixed === undefined) throw new Error("fixed est obligatoire avec une stratégie personnalisée");
  return { spec, fixed };
}

function validate<P>(prices: number[], c: WalkForwardConfig<P>, spec: StrategySpec<P>, fixed: P) {
  if (!c.grid.length) throw new Error("grille de paramètres vide");
  const maxWarm = Math.max(...c.grid.map(spec.warmup), spec.warmup(fixed));
  if (c.trainBars < maxWarm + 50) throw new Error(`trainBars trop court : minimum ${maxWarm + 50} (plus grand échauffement + 50)`);
  if (c.testBars < 30) throw new Error("testBars trop court : minimum 30");
  if ((c.stepBars ?? c.testBars) < 1) throw new Error("stepBars doit être >= 1");
  if (prices.length < c.trainBars + c.testBars) {
    throw new Error(`série trop courte : ${prices.length} barres, il en faut au moins ${c.trainBars + c.testBars}`);
  }
}

/**
 * Évalue des paramètres sur [from, to). La stratégie reçoit `warmup` barres d'échauffement AVANT `from`
 * (passé uniquement) sans pouvoir trader pendant l'échauffement, pour ne pas perdre le début de la fenêtre.
 * Le capital repart à zéro position à chaque fenêtre : les fenêtres sont indépendantes.
 */
export function evaluateSegment(
  prices: number[],
  from: number,
  to: number,
  make: () => Strategy,
  warmup: number,
  exec: Partial<ExecutionConfig> = {},
) {
  const start = Math.max(0, from - warmup);
  const r = runBacktest(prices.slice(start, to), make(), exec);
  const cfg = { ...DEFAULT_EXECUTION, ...exec };
  const bh = (buyAndHoldEquity(prices[from], prices[to - 1], cfg) / cfg.initialCashUsd - 1) * 100;
  return { returnPct: r.returnPct, trades: r.trades.length, buyHoldPct: bh, maxDrawdownPct: r.maxDrawdownPct, feesPaid: r.feesPaid };
}

function evaluate<P>(prices: number[], from: number, to: number, p: P, spec: StrategySpec<P>, exec: Partial<ExecutionConfig>) {
  const r = evaluateSegment(prices, from, to, () => spec.make(p), spec.warmup(p), exec);
  return { returnPct: r.returnPct, trades: r.trades };
}

const compound = (rs: number[]) => (rs.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function walkForward<P = ParamSet>(prices: number[], config: WalkForwardConfig<P>): WalkForwardResult<P> {
  const { spec, fixed } = resolve(config);
  validate(prices, config, spec, fixed);
  const exec = config.exec ?? {};
  const cfg = { ...DEFAULT_EXECUTION, ...exec };
  const step = config.stepBars ?? config.testBars;
  const folds: Fold<P>[] = [];

  for (let s = 0; s + config.trainBars + config.testBars <= prices.length; s += step) {
    const testStart = s + config.trainBars;
    const testEnd = testStart + config.testBars;

    // Choix des paramètres : uniquement avec prices[s, testStart). Rien après testStart n'est lu ici.
    let best = config.grid[0];
    let bestRet = -Infinity;
    for (const p of config.grid) {
      const ret = runBacktest(prices.slice(s, testStart), spec.make(p), exec).returnPct;
      if (ret > bestRet) {
        bestRet = ret;
        best = p;
      }
    }

    const oos = evaluate(prices, testStart, testEnd, best, spec, exec);
    const fix = evaluate(prices, testStart, testEnd, fixed, spec, exec);
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
