/**
 * Simulateur de position à LEVIER (long uniquement) avec liquidation, pour comparer deux façons de gérer le risque :
 *  - "reinject" : on prend un petit gain (take-profit) et, quand le prix approche de la liquidation, on réinjecte du
 *                 capital du wallet pour repousser la liquidation (« à fond » par défaut) ;
 *  - "bounded"  : risque borné : un stop-loss prévu à l'avance, aucune réinjection, la perte est connue d'avance.
 *
 * L'entrée est SANS AVANTAGE : on ouvre une position dès qu'on est à plat (après un délai). Cela isole l'effet de la
 * STRUCTURE de gain/perte, indépendamment de la qualité de l'idée d'entrée.
 *
 * Limites (elles sous-estiment le risque réel) :
 *  - on ne voit que les prix de clôture : les mèches intrabarres qui déclenchent une liquidation réelle sont invisibles ;
 *  - pas de financement (funding), pas de glissement, liquidation à la marge de maintenance sans frais de liquidation ;
 *  - paramètres de marge génériques : ceux de votre plateforme diffèrent.
 */
export type Policy = "reinject" | "bounded";
export type Side = "long" | "short";
export type EntrySignal = Side | null;

/**
 * Règle d'entrée : reçoit les prix un par un (jamais le futur). Appelée à CHAQUE barre pour tenir son état à jour ;
 * le simulateur n'en tient compte que quand on est à plat. Le signal calculé à la clôture de la barre i
 * s'exécute au prix de la barre i+1 (pas d'anticipation).
 */
export interface EntryRule {
  readonly name: string;
  onPrice(price: number): EntrySignal;
}

export interface LeverageConfig {
  /** Capital total au départ (marge + réserve). */
  walletUsd: number;
  /** Part du capital libre engagée comme marge à l'ouverture (0..1]. */
  stakeFraction: number;
  leverage: number;
  /** Clôture quand le prix gagne ce pourcentage (0.01 = +1 %). */
  takeProfitPct: number;
  /** Frais par côté, sur la valeur notionnelle (0.0005 = 0,05 %). */
  feeRate: number;
  /** Marge de maintenance : liquidation quand le capital de la position tombe sous ce taux de la valeur notionnelle. */
  maintenanceRate: number;
  policy: Policy;
  /** bounded : clôture si le prix baisse de ce pourcentage. Défaut : la moitié de la distance de liquidation (0.5 / levier). */
  stopLossPct?: number;
  /** reinject : on réinjecte quand le prix est à moins de ce pourcentage (relatif) du prix de liquidation. */
  reinjectTrigger: number;
  /** reinject : part du capital libre injectée à chaque fois (1 = « à fond »). */
  reinjectFraction: number;
  /**
   * Coût de financement par barre, en part du notionnel de la position (intérêts d'emprunt en marge, ou funding
   * d'un perpétuel). Prélevé sur la marge à chaque barre où la position est ouverte. 0 = ignoré (défaut).
   * À régler d'après le barème de VOTRE plateforme : ce simulateur n'en connaît pas.
   */
  financingRate: number;
  /** Clôture forcée au prix du marché après autant de barres. */
  maxHoldBars: number;
  /** Barres d'attente à plat entre deux positions. */
  cooldownBars: number;
}

export const DEFAULT_LEVERAGE: LeverageConfig = {
  walletUsd: 10_000,
  stakeFraction: 0.1,
  leverage: 10,
  takeProfitPct: 0.01,
  feeRate: 0.0005,
  maintenanceRate: 0.005,
  policy: "reinject",
  reinjectTrigger: 0.03,
  reinjectFraction: 1,
  financingRate: 0,
  maxHoldBars: 2000,
  cooldownBars: 5,
};

const MIN_CASH = 1; // en dessous, on considère qu'il n'y a plus de quoi ouvrir une position

export interface PathResult {
  finalWallet: number;
  /** Positions clôturées (hors position encore ouverte à la fin). */
  trades: number;
  wins: number;
  liquidations: number;
  stops: number;
  timeouts: number;
  /** Nombre de réinjections. */
  reinjections: number;
  /** Positions ouvertes (clôturées ou non). */
  entries: number;
  longs: number;
  shorts: number;
  /** Barres où l'on était à plat, hors délai d'attente, avec de quoi ouvrir : le « temps disponible pour entrer ». */
  eligibleBars: number;
  /** Signaux d'entrée vus pendant ces barres (sert à calibrer une référence au hasard de même fréquence). */
  signalsEligible: number;
  /** Durée de la plus longue position, en barres. */
  longestHoldBars: number;
  /** Pire baisse du patrimoine depuis son sommet (%). */
  maxDrawdownPct: number;
  /** Part maximale du capital engagée dans la position (marge / (marge + capital libre)), à un instant donné (%). */
  peakAtRiskPct: number;
  openAtEnd: boolean;
}

export function liquidationPrice(margin: number, qty: number, entry: number, maintenanceRate: number, side: Side = "long"): number {
  if (side === "short") return (margin + qty * entry) / (qty * (1 + maintenanceRate));
  return Math.max(0, (qty * entry - margin) / (qty * (1 - maintenanceRate)));
}

export function validateLeverage(c: LeverageConfig) {
  if (!(c.walletUsd > 0)) throw new Error("walletUsd doit être > 0");
  if (!(c.stakeFraction > 0 && c.stakeFraction <= 1)) throw new Error("stakeFraction doit être dans ]0, 1]");
  if (!(c.leverage >= 1)) throw new Error("leverage doit être >= 1");
  if (!(c.takeProfitPct > 0)) throw new Error("takeProfitPct doit être > 0");
  if (!(c.feeRate >= 0 && c.feeRate < 0.05)) throw new Error("feeRate doit être dans [0, 0.05[");
  if (!(c.maintenanceRate >= 0 && c.maintenanceRate < 0.5)) throw new Error("maintenanceRate doit être dans [0, 0.5[");
  if (c.policy !== "reinject" && c.policy !== "bounded") throw new Error(`politique inconnue : ${c.policy}`);
  if (c.stopLossPct !== undefined && !(c.stopLossPct > 0 && c.stopLossPct < 1)) throw new Error("stopLossPct doit être dans ]0, 1[");
  if (!(c.reinjectTrigger >= 0 && c.reinjectTrigger < 1)) throw new Error("reinjectTrigger doit être dans [0, 1[");
  if (!(c.reinjectFraction > 0 && c.reinjectFraction <= 1)) throw new Error("reinjectFraction doit être dans ]0, 1]");
  if (!(c.financingRate >= 0 && c.financingRate < 0.01)) throw new Error("financingRate doit être dans [0, 0.01[ (par barre)");
  if (!(c.maxHoldBars >= 1)) throw new Error("maxHoldBars doit être >= 1");
  if (!(c.cooldownBars >= 0)) throw new Error("cooldownBars doit être >= 0");
}

export function simulateLeveraged(prices: number[], config: Partial<LeverageConfig> = {}, rule?: EntryRule): PathResult {
  const c = { ...DEFAULT_LEVERAGE, ...config };
  validateLeverage(c);
  if (prices.length < 2) throw new Error("il faut au moins 2 prix");
  for (const p of prices) if (!Number.isFinite(p) || p <= 0) throw new Error(`prix invalide : ${p}`);
  const stop = c.stopLossPct ?? 0.5 / c.leverage;

  let cash = c.walletUsd;
  let inPos = false;
  let side: Side = "long";
  let sgn = 1;
  let margin = 0;
  let qty = 0;
  let entry = 0;
  let entryBar = 0;
  let cashBeforeOpen = 0;
  let cooldownLeft = 0;
  let pending: Side | null = null;
  let peak = c.walletUsd;
  const r = { trades: 0, wins: 0, liquidations: 0, stops: 0, timeouts: 0, reinjections: 0, longest: 0, maxDD: 0, peakRisk: 0, entries: 0, longs: 0, shorts: 0, eligible: 0, signals: 0 };

  const open = (s: Side, price: number, bar: number): boolean => {
    const m = Math.min(cash * c.stakeFraction, cash / (1 + c.leverage * c.feeRate));
    if (cash < MIN_CASH || m <= 0) return false;
    const notional = m * c.leverage;
    cashBeforeOpen = cash;
    cash -= m + notional * c.feeRate;
    margin = m;
    qty = notional / price;
    entry = price;
    entryBar = bar;
    side = s;
    sgn = s === "long" ? 1 : -1;
    inPos = true;
    r.entries++;
    if (s === "long") r.longs++;
    else r.shorts++;
    return true;
  };

  const close = (kind: "tp" | "stop" | "timeout" | "liq", price: number, bar: number) => {
    if (kind !== "liq") {
      // en cas de liquidation, la marge est perdue et ce qu'il en reste est déjà hors de `cash`
      const proceeds = margin + sgn * qty * (price - entry) - qty * price * c.feeRate;
      cash += Math.max(0, proceeds);
    }
    r.trades++;
    if (cash > cashBeforeOpen) r.wins++;
    if (kind === "liq") r.liquidations++;
    if (kind === "stop") r.stops++;
    if (kind === "timeout") r.timeouts++;
    r.longest = Math.max(r.longest, bar - entryBar);
    inPos = false;
    cooldownLeft = c.cooldownBars;
  };

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];

    // 1) gérer la position ouverte
    if (inPos) {
      if (i > entryBar) margin -= c.financingRate * qty * entry; // coût de financement de la barre écoulée
      const equity = margin + sgn * qty * (p - entry);
      const hitTp = side === "long" ? p >= entry * (1 + c.takeProfitPct) : p <= entry * (1 - c.takeProfitPct);
      const hitStop = side === "long" ? p <= entry * (1 - stop) : p >= entry * (1 + stop);
      if (equity <= c.maintenanceRate * qty * p) close("liq", p, i);
      else if (hitTp) close("tp", p, i);
      else if (c.policy === "bounded" && hitStop) close("stop", p, i);
      else if (i - entryBar >= c.maxHoldBars) close("timeout", p, i);
      else if (c.policy === "reinject" && cash >= MIN_CASH) {
        const pl = liquidationPrice(margin, qty, entry, c.maintenanceRate, side);
        const distance = side === "long" ? (p - pl) / p : (pl - p) / p;
        if (distance <= c.reinjectTrigger) {
          const amount = cash * c.reinjectFraction;
          cash -= amount;
          margin += amount;
          r.reinjections++;
        }
      }
    } else if (cooldownLeft > 0) {
      cooldownLeft--;
    }

    // 2) ouvrir : sans règle, dès qu'on est à plat (même barre) ; avec règle, au prix de la barre qui suit le signal
    const canEnter = !inPos && cooldownLeft === 0 && i < prices.length - 1 && cash >= MIN_CASH;
    if (!rule) {
      if (canEnter) open("long", p, i);
    } else {
      if (pending && !inPos) {
        // jamais sur la dernière barre : la position ne pourrait plus évoluer et ne ferait que payer des frais
        if (cooldownLeft === 0 && cash >= MIN_CASH && i < prices.length - 1) open(pending, p, i);
        pending = null;
      }
      const signal = rule.onPrice(p); // appelée à chaque barre : la règle garde son état à jour
      if (canEnter && !inPos) {
        r.eligible++;
        if (signal) {
          r.signals++;
          pending = signal;
        }
      }
    }

    const posEquity = inPos ? Math.max(0, margin + sgn * qty * (p - entry)) : 0;
    const wealth = cash + posEquity;
    peak = Math.max(peak, wealth);
    r.maxDD = Math.max(r.maxDD, (peak - wealth) / peak);
    if (inPos) r.peakRisk = Math.max(r.peakRisk, margin / (margin + cash));
  }

  let openAtEnd = false;
  if (inPos) {
    const p = prices[prices.length - 1];
    cash += Math.max(0, margin + sgn * qty * (p - entry) - qty * p * c.feeRate);
    r.longest = Math.max(r.longest, prices.length - 1 - entryBar);
    openAtEnd = true;
  }

  return {
    finalWallet: cash,
    trades: r.trades,
    wins: r.wins,
    liquidations: r.liquidations,
    stops: r.stops,
    timeouts: r.timeouts,
    reinjections: r.reinjections,
    entries: r.entries,
    longs: r.longs,
    shorts: r.shorts,
    eligibleBars: r.eligible,
    signalsEligible: r.signals,
    longestHoldBars: r.longest,
    maxDrawdownPct: r.maxDD * 100,
    peakAtRiskPct: r.peakRisk * 100,
    openAtEnd,
  };
}

export interface Summary {
  paths: number;
  tradeWinRatePct: number | null;
  medianFinalPct: number;
  meanFinalPct: number;
  /** Part des trajectoires terminées au-dessus du capital de départ. */
  profitablePct: number;
  loss50Pct: number;
  loss90Pct: number;
  /** Part des trajectoires avec au moins une liquidation. */
  liquidatedPct: number;
  medianMaxDrawdownPct: number;
  /** Part max du capital engagée dans la position à un instant donné : médiane, et pire cas parmi les trajectoires. */
  medianPeakAtRiskPct: number;
  worstPeakAtRiskPct: number;
  medianLongestHoldBars: number;
  medianTrades: number;
  meanReinjections: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function summarize(results: PathResult[], walletUsd: number): Summary {
  if (!results.length) throw new Error("aucune trajectoire");
  const finals = results.map((r) => (r.finalWallet / walletUsd - 1) * 100);
  const trades = results.reduce((a, r) => a + r.trades, 0);
  const wins = results.reduce((a, r) => a + r.wins, 0);
  const share = (pred: (x: number) => boolean) => (finals.filter(pred).length / finals.length) * 100;
  return {
    paths: results.length,
    tradeWinRatePct: trades ? (wins / trades) * 100 : null,
    medianFinalPct: median(finals),
    meanFinalPct: mean(finals),
    profitablePct: share((x) => x > 0),
    loss50Pct: share((x) => x <= -50),
    loss90Pct: share((x) => x <= -90),
    liquidatedPct: (results.filter((r) => r.liquidations > 0).length / results.length) * 100,
    medianMaxDrawdownPct: median(results.map((r) => r.maxDrawdownPct)),
    medianPeakAtRiskPct: median(results.map((r) => r.peakAtRiskPct)),
    worstPeakAtRiskPct: Math.max(...results.map((r) => r.peakAtRiskPct)),
    medianLongestHoldBars: median(results.map((r) => r.longestHoldBars)),
    medianTrades: median(results.map((r) => r.trades)),
    meanReinjections: mean(results.map((r) => r.reinjections)),
  };
}
