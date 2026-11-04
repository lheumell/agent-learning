import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_EXECUTION,
  Portfolio,
  buyAndHoldEquity,
  type ExecutionConfig,
  type PortfolioSnapshot,
  type Trade,
} from "./portfolio.js";
import { DEFAULT_LIMITS, getCheckedPrice, normalizeSymbol, type PriceSource, type QualityLimits } from "./prices.js";
import type { Signal, Strategy } from "./strategy.js";

const MAX_HISTORY = 2000;

interface PaperState {
  version: 1;
  symbol: string;
  strategy: string;
  exec: ExecutionConfig;
  startedAt: string;
  startPrice: number | null;
  tick: number;
  skipped: number;
  /** Derniers prix reçus : sert à reconstruire l'état de la stratégie après un redémarrage. */
  history: number[];
  /** Signal calculé au tick précédent, à exécuter au prix du tick suivant. */
  pending: Signal;
  lastPrice: number | null;
  portfolio: PortfolioSnapshot;
}

export interface PaperOptions {
  symbol: string;
  makeStrategy: () => Strategy;
  source: PriceSource;
  exec?: Partial<ExecutionConfig>;
  limits?: QualityLimits;
  statePath: string;
  journalPath: string;
  killSwitchPath?: string;
  /** true = repart de zéro même si un état existe. */
  reset?: boolean;
  now?: () => Date;
}

export type TickResult =
  | { status: "ok"; price: number; signal: Signal; trade: Trade | null; equity: number; tick: number }
  | { status: "skipped"; reason: string }
  | { status: "stopped"; reason: string };

export interface PaperStatus {
  symbol: string;
  strategy: string;
  startedAt: string;
  ticks: number;
  skipped: number;
  lastPrice: number | null;
  equity: number;
  returnPct: number;
  buyHoldReturnPct: number | null;
  trades: number;
  roundTrips: number;
  winRate: number | null;
  openPosition: boolean;
  feesPaid: number;
  pending: Signal;
}

/**
 * Trading « papier » : prix réels, argent fictif.
 * Même stratégie, même Portfolio et même règle « signal à la barre i, exécution à la barre i+1 »
 * que le backtest : les deux sont donc directement comparables.
 * Un prix refusé par le contrôle qualité (périmé, incertain, erreur réseau) saute le tick
 * et n'alimente PAS la stratégie.
 */
export class PaperTrader {
  private strategy: Strategy;
  private portfolio: Portfolio;

  private constructor(
    private o: PaperOptions,
    private state: PaperState,
  ) {
    this.strategy = o.makeStrategy();
    // Rejoue l'historique pour reconstruire l'état interne de la stratégie (signaux ignorés).
    for (const p of state.history) this.strategy.onPrice(p);
    this.portfolio = Portfolio.restore(state.exec, state.portfolio);
  }

  static open(o: PaperOptions): PaperTrader {
    const symbol = normalizeSymbol(o.symbol);
    const exec: ExecutionConfig = { ...DEFAULT_EXECUTION, ...o.exec };
    const strategyName = o.makeStrategy().name;

    if (!o.reset && existsSync(o.statePath)) {
      const prev = JSON.parse(readFileSync(o.statePath, "utf8")) as PaperState;
      if (prev.version !== 1) throw new Error(`version d'état inconnue : ${prev.version}`);
      if (prev.symbol !== symbol || prev.strategy !== strategyName) {
        throw new Error(
          `l'état existant est pour ${prev.symbol} / ${prev.strategy}, pas ${symbol} / ${strategyName}. ` +
            `Utilisez --reset pour repartir de zéro.`,
        );
      }
      for (const k of ["feeRate", "slippageRate", "allocation", "initialCashUsd"] as const) {
        if (prev.exec[k] !== exec[k]) {
          throw new Error(`le paramètre ${k} a changé (${prev.exec[k]} → ${exec[k]}). Utilisez --reset.`);
        }
      }
      return new PaperTrader(o, prev);
    }

    const state: PaperState = {
      version: 1,
      symbol,
      strategy: strategyName,
      exec,
      startedAt: (o.now ?? (() => new Date()))().toISOString(),
      startPrice: null,
      tick: 0,
      skipped: 0,
      history: [],
      pending: "hold",
      lastPrice: null,
      portfolio: new Portfolio(exec).snapshot(),
    };
    return new PaperTrader(o, state);
  }

  private now() {
    return (this.o.now ?? (() => new Date()))();
  }

  private journal(entry: Record<string, unknown>) {
    mkdirSync(dirname(this.o.journalPath), { recursive: true });
    appendFileSync(this.o.journalPath, JSON.stringify({ t: this.now().toISOString(), ...entry }) + "\n");
  }

  private save() {
    this.state.portfolio = this.portfolio.snapshot();
    mkdirSync(dirname(this.o.statePath), { recursive: true });
    const tmp = this.o.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.o.statePath); // écriture atomique : pas d'état à moitié écrit
  }

  async tick(): Promise<TickResult> {
    if (this.o.killSwitchPath && existsSync(this.o.killSwitchPath)) {
      return { status: "stopped", reason: `kill switch actif (${this.o.killSwitchPath})` };
    }

    let price: number;
    try {
      price = (await getCheckedPrice(this.o.source, this.state.symbol, this.o.limits ?? DEFAULT_LIMITS)).priceUsd;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.state.skipped++;
      this.journal({ event: "skipped", reason });
      this.save();
      return { status: "skipped", reason };
    }

    const tick = ++this.state.tick;
    if (this.state.startPrice === null) this.state.startPrice = price;

    // 1) exécuter le signal du tick précédent au prix d'aujourd'hui
    let trade: Trade | null = null;
    if (this.state.pending === "buy") trade = this.portfolio.buy(price, tick);
    else if (this.state.pending === "sell") trade = this.portfolio.sell(price, tick);
    if (trade) this.journal({ event: "trade", tick, ...trade });

    // 2) mesurer, puis nourrir la stratégie avec ce prix
    const equity = this.portfolio.equity(price);
    const signal = this.strategy.onPrice(price);
    this.state.pending = signal;
    this.state.lastPrice = price;
    this.state.history.push(price);
    if (this.state.history.length > MAX_HISTORY) this.state.history.shift();

    this.journal({ event: "tick", tick, price, signal, equity });
    this.save();
    return { status: "ok", price, signal, trade, equity, tick };
  }

  status(): PaperStatus {
    const s = this.state;
    const pf = this.portfolio;
    const equity = s.lastPrice === null ? pf.cfg.initialCashUsd : pf.equity(s.lastPrice);
    const bh =
      s.startPrice !== null && s.lastPrice !== null
        ? (buyAndHoldEquity(s.startPrice, s.lastPrice, pf.cfg) / pf.cfg.initialCashUsd - 1) * 100
        : null;
    return {
      symbol: s.symbol,
      strategy: s.strategy,
      startedAt: s.startedAt,
      ticks: s.tick,
      skipped: s.skipped,
      lastPrice: s.lastPrice,
      equity,
      returnPct: (equity / pf.cfg.initialCashUsd - 1) * 100,
      buyHoldReturnPct: bh,
      trades: pf.trades.length,
      roundTrips: pf.roundTrips,
      winRate: pf.roundTrips > 0 ? pf.wins / pf.roundTrips : null,
      openPosition: pf.inPosition,
      feesPaid: pf.feesPaid,
      pending: s.pending,
    };
  }
}

export interface RunOptions {
  intervalSec: number;
  maxTicks?: number;
  /** Arrête après N ticks sautés d'affilée (source de prix en panne). */
  maxConsecutiveSkips?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
  shouldStop?: () => boolean;
}

export async function runPaper(trader: PaperTrader, o: RunOptions): Promise<void> {
  const log = o.log ?? console.log;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxSkips = o.maxConsecutiveSkips ?? 10;
  let skips = 0;

  for (let n = 0; o.maxTicks === undefined || n < o.maxTicks; n++) {
    if (o.shouldStop?.()) return log("⏹ arrêt demandé");
    const r = await trader.tick();
    if (r.status === "stopped") return log(`⏹ ${r.reason}`);
    if (r.status === "skipped") {
      skips++;
      log(`⚠ tick sauté : ${r.reason}`);
      if (skips >= maxSkips) return log(`⏹ ${skips} ticks sautés d'affilée : arrêt`);
    } else {
      skips = 0;
      const t = r.trade ? ` | ${r.trade.side === "buy" ? "ACHAT" : "VENTE"} @ ${r.trade.price.toFixed(2)}` : "";
      log(`#${r.tick} ${r.price.toFixed(2)} → signal ${r.signal}${t} | capital ${r.equity.toFixed(2)}`);
    }
    if (o.maxTicks === undefined || n + 1 < o.maxTicks) await sleep(o.intervalSec * 1000);
  }
}
