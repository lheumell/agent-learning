import type { Strategy } from "./strategy.js";

export interface BacktestConfig {
  initialCashUsd: number;
  /** Frais par transaction, ex. 0.001 = 0,1 %. */
  feeRate: number;
  /** Écart entre le prix vu et le prix obtenu, ex. 0.0005 = 0,05 %. Défavorable à chaque trade. */
  slippageRate: number;
  /** Part du capital investie à l'achat (0..1). */
  allocation: number;
}

export const DEFAULT_BACKTEST: BacktestConfig = {
  initialCashUsd: 1000,
  feeRate: 0.001,
  slippageRate: 0.0005,
  allocation: 1,
};

export interface Trade {
  index: number;
  side: "buy" | "sell";
  /** Prix réellement obtenu (slippage inclus). */
  price: number;
  qty: number;
  feeUsd: number;
}

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

function validate(prices: number[], cfg: BacktestConfig) {
  if (prices.length < 2) throw new Error("il faut au moins 2 prix");
  for (const p of prices) {
    if (!Number.isFinite(p) || p <= 0) throw new Error(`prix invalide dans la série : ${p}`);
  }
  if (cfg.initialCashUsd <= 0) throw new Error("capital initial invalide");
  if (cfg.feeRate < 0 || cfg.feeRate >= 1) throw new Error("frais invalides");
  if (cfg.slippageRate < 0 || cfg.slippageRate >= 1) throw new Error("slippage invalide");
  if (cfg.allocation <= 0 || cfg.allocation > 1) throw new Error("allocation doit être dans ]0, 1]");
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
  const cfg = { ...DEFAULT_BACKTEST, ...config };
  validate(prices, cfg);

  let cash = cfg.initialCashUsd;
  let qty = 0;
  let entryCost = 0;
  let feesPaid = 0;
  let wins = 0;
  let roundTrips = 0;
  const trades: Trade[] = [];
  const equityCurve: number[] = [];
  let pending: "buy" | "sell" | "hold" = "hold";

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];

    if (pending === "buy" && qty === 0) {
      const price = p * (1 + cfg.slippageRate);
      const budget = cash * cfg.allocation;
      const q = budget / (price * (1 + cfg.feeRate));
      const fee = q * price * cfg.feeRate;
      cash -= q * price + fee;
      qty = q;
      entryCost = q * price + fee;
      feesPaid += fee;
      trades.push({ index: i, side: "buy", price, qty: q, feeUsd: fee });
    } else if (pending === "sell" && qty > 0) {
      const price = p * (1 - cfg.slippageRate);
      const gross = qty * price;
      const fee = gross * cfg.feeRate;
      cash += gross - fee;
      feesPaid += fee;
      trades.push({ index: i, side: "sell", price, qty, feeUsd: fee });
      roundTrips++;
      if (gross - fee > entryCost) wins++;
      qty = 0;
      entryCost = 0;
    }

    equityCurve.push(cash + qty * p);
    pending = strategy.onPrice(p);
  }

  const finalEquity = equityCurve[equityCurve.length - 1];

  // Référence : tout acheter à la première barre (mêmes frais et slippage), puis garder.
  const bhPrice = prices[0] * (1 + cfg.slippageRate);
  const bhQty = (cfg.initialCashUsd * cfg.allocation) / (bhPrice * (1 + cfg.feeRate));
  const bhEquity =
    cfg.initialCashUsd * (1 - cfg.allocation) + bhQty * prices[prices.length - 1];

  return {
    strategy: strategy.name,
    trades,
    finalEquity,
    returnPct: (finalEquity / cfg.initialCashUsd - 1) * 100,
    buyHoldReturnPct: (bhEquity / cfg.initialCashUsd - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    feesPaid,
    roundTrips,
    winRate: roundTrips > 0 ? wins / roundTrips : null,
    openPosition: qty > 0,
    equityCurve,
  };
}
