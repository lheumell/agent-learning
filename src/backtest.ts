import {
  DEFAULT_EXECUTION,
  Portfolio,
  buyAndHoldEquity,
  type ExecutionConfig,
  type Trade,
} from "./portfolio.js";
import type { Strategy } from "./strategy.js";

export type BacktestConfig = ExecutionConfig;
export const DEFAULT_BACKTEST = DEFAULT_EXECUTION;
export type { Trade };

export interface BacktestResult {
  strategy: string;
  trades: Trade[];
  finalEquity: number;
  returnPct: number;
  buyHoldReturnPct: number;
  maxDrawdownPct: number;
  feesPaid: number;
  roundTrips: number;
  /** null s'il n'y a eu aucun aller-retour terminé. */
  winRate: number | null;
  openPosition: boolean;
  equityCurve: number[];
}

function validatePrices(prices: number[]) {
  if (prices.length < 2) throw new Error("il faut au moins 2 prix");
  for (const p of prices) {
    if (!Number.isFinite(p) || p <= 0) throw new Error(`prix invalide dans la série : ${p}`);
  }
}

export function maxDrawdownPct(curve: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    worst = Math.max(worst, (peak - v) / peak);
  }
  return worst * 100;
}

/**
 * Backtest long-only, une position à la fois.
 *
 * Anti-biais : le signal calculé avec le prix de la barre i est exécuté au prix de la
 * barre i+1. Exécuter au prix qui a produit le signal reviendrait à connaître le futur.
 * La position ouverte à la fin est valorisée au dernier prix, sans frais de sortie
 * (même convention pour la stratégie et pour « acheter et garder »).
 */
export function runBacktest(
  prices: number[],
  strategy: Strategy,
  config: Partial<BacktestConfig> = {},
): BacktestResult {
  validatePrices(prices);
  const cfg = { ...DEFAULT_BACKTEST, ...config };
  const pf = new Portfolio(cfg);
  const equityCurve: number[] = [];
  let pending: "buy" | "sell" | "hold" = "hold";

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (pending === "buy") pf.buy(p, i);
    else if (pending === "sell") pf.sell(p, i);
    equityCurve.push(pf.equity(p));
    pending = strategy.onPrice(p);
  }

  const finalEquity = equityCurve[equityCurve.length - 1];
  const bhEquity = buyAndHoldEquity(prices[0], prices[prices.length - 1], cfg);

  return {
    strategy: strategy.name,
    trades: pf.trades,
    finalEquity,
    returnPct: (finalEquity / cfg.initialCashUsd - 1) * 100,
    buyHoldReturnPct: (bhEquity / cfg.initialCashUsd - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    feesPaid: pf.feesPaid,
    roundTrips: pf.roundTrips,
    winRate: pf.roundTrips > 0 ? pf.wins / pf.roundTrips : null,
    openPosition: pf.inPosition,
    equityCurve,
  };
}
