export interface ExecutionConfig {
  initialCashUsd: number;
  /** Frais par transaction, ex. 0.001 = 0,1 %. */
  feeRate: number;
  /** Écart entre le prix vu et le prix obtenu, ex. 0.0005 = 0,05 %. Défavorable à chaque trade. */
  slippageRate: number;
  /** Part du capital investie à l'achat (0..1). */
  allocation: number;
}

export const DEFAULT_EXECUTION: ExecutionConfig = {
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

export function validateExecution(cfg: ExecutionConfig) {
  if (!(cfg.initialCashUsd > 0)) throw new Error("capital initial invalide");
  if (!(cfg.feeRate >= 0 && cfg.feeRate < 1)) throw new Error("frais invalides");
  if (!(cfg.slippageRate >= 0 && cfg.slippageRate < 1)) throw new Error("slippage invalide");
  if (!(cfg.allocation > 0 && cfg.allocation <= 1)) throw new Error("allocation doit être dans ]0, 1]");
}

export interface PortfolioSnapshot {
  cash: number;
  qty: number;
  entryCost: number;
  feesPaid: number;
  wins: number;
  roundTrips: number;
  trades: Trade[];
}

/**
 * Portefeuille long-only à une position. C'est LE code d'exécution : le backtest et le
 * mode papier l'utilisent tous les deux, donc ils appliquent exactement les mêmes coûts.
 */
export class Portfolio {
  cash: number;
  qty = 0;
  entryCost = 0;
  feesPaid = 0;
  wins = 0;
  roundTrips = 0;
  trades: Trade[] = [];

  constructor(public readonly cfg: ExecutionConfig) {
    validateExecution(cfg);
    this.cash = cfg.initialCashUsd;
  }

  get inPosition() {
    return this.qty > 0;
  }

  /** Achète si on n'est pas en position. Retourne le trade, ou null s'il est ignoré. */
  buy(marketPrice: number, index: number): Trade | null {
    if (this.qty > 0) return null;
    const price = marketPrice * (1 + this.cfg.slippageRate);
    const budget = this.cash * this.cfg.allocation;
    const q = budget / (price * (1 + this.cfg.feeRate));
    const fee = q * price * this.cfg.feeRate;
    this.cash -= q * price + fee;
    // Pleine allocation : l'arrondi flottant peut laisser -1e-13. Un solde négatif n'a pas de sens
    // (et serait refusé au redémarrage). On ne corrige que ce résidu d'arrondi, jamais un vrai découvert.
    if (this.cash < 0 && this.cash > -1e-9) this.cash = 0;
    this.qty = q;
    this.entryCost = q * price + fee;
    this.feesPaid += fee;
    const t: Trade = { index, side: "buy", price, qty: q, feeUsd: fee };
    this.trades.push(t);
    return t;
  }

  /** Vend si on est en position. Retourne le trade, ou null s'il est ignoré. */
  sell(marketPrice: number, index: number): Trade | null {
    if (this.qty === 0) return null;
    const price = marketPrice * (1 - this.cfg.slippageRate);
    const gross = this.qty * price;
    const fee = gross * this.cfg.feeRate;
    this.cash += gross - fee;
    this.feesPaid += fee;
    const t: Trade = { index, side: "sell", price, qty: this.qty, feeUsd: fee };
    this.trades.push(t);
    this.roundTrips++;
    if (gross - fee > this.entryCost) this.wins++;
    this.qty = 0;
    this.entryCost = 0;
    return t;
  }

  equity(marketPrice: number): number {
    return this.cash + this.qty * marketPrice;
  }

  snapshot(): PortfolioSnapshot {
    const { cash, qty, entryCost, feesPaid, wins, roundTrips, trades } = this;
    return { cash, qty, entryCost, feesPaid, wins, roundTrips, trades: [...trades] };
  }

  static restore(cfg: ExecutionConfig, s: PortfolioSnapshot): Portfolio {
    const p = new Portfolio(cfg);
    for (const k of ["cash", "qty", "entryCost", "feesPaid", "wins", "roundTrips"] as const) {
      if (!Number.isFinite(s[k]) || s[k] < 0) throw new Error(`état du portefeuille corrompu (${k})`);
    }
    Object.assign(p, { ...s, trades: [...s.trades] });
    return p;
  }
}

/** Valeur finale de « tout acheter au premier prix puis garder », avec les mêmes coûts d'entrée. */
export function buyAndHoldEquity(firstPrice: number, lastPrice: number, cfg: ExecutionConfig): number {
  const bhPrice = firstPrice * (1 + cfg.slippageRate);
  const bhQty = (cfg.initialCashUsd * cfg.allocation) / (bhPrice * (1 + cfg.feeRate));
  return cfg.initialCashUsd * (1 - cfg.allocation) + bhQty * lastPrice;
}
