import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest.js";
import { formatStatus, paperCommand } from "../src/paper-cli.js";
import { PaperTrader, runPaper, type PaperOptions } from "../src/paper.js";
import type { PriceQuote, PriceSource } from "../src/prices.js";
import { syntheticPrices } from "../src/simulate.js";
import { SmaCrossover } from "../src/strategy.js";

/** Sert une série de prix tick après tick. `failAt` : numéros d'appel (0-based) qui échouent. */
class SeriesSource implements PriceSource {
  calls = 0;
  constructor(
    private prices: number[],
    private failAt = new Set<number>(),
    private ageSec = 0,
  ) {}
  async getPrice(symbol: string): Promise<PriceQuote> {
    const i = this.calls++;
    if (this.failAt.has(i)) throw new Error("réseau indisponible");
    return {
      symbol,
      priceUsd: this.prices[i],
      confidenceUsd: 0,
      publishedAt: new Date(Date.now() - this.ageSec * 1000),
      source: "series",
    };
  }
}

const prices = syntheticPrices({ n: 400, seed: 11, vol: 0.02 });
const mk = () => new SmaCrossover(3, 8);

function opts(source: PriceSource, over: Partial<PaperOptions> = {}): PaperOptions {
  const dir = mkdtempSync(join(tmpdir(), "paper-"));
  return {
    symbol: "ETH",
    makeStrategy: mk,
    source,
    statePath: join(dir, "state.json"),
    journalPath: join(dir, "journal.jsonl"),
    killSwitchPath: join(dir, "STOP"),
    ...over,
  };
}

async function ticks(t: PaperTrader, n: number) {
  for (let i = 0; i < n; i++) await t.tick();
}

describe("PaperTrader", () => {
  it("donne exactement le même résultat que le backtest sur la même série", async () => {
    const t = PaperTrader.open(opts(new SeriesSource(prices)));
    await ticks(t, prices.length);
    const bt = runBacktest(prices, mk());
    const s = t.status();
    expect(bt.trades.length).toBeGreaterThan(4); // le test doit réellement trader
    expect(s.equity).toBeCloseTo(bt.finalEquity, 9);
    expect(s.returnPct).toBeCloseTo(bt.returnPct, 9);
    expect(s.buyHoldReturnPct).toBeCloseTo(bt.buyHoldReturnPct, 9);
    expect(s.trades).toBe(bt.trades.length);
    expect(s.feesPaid).toBeCloseTo(bt.feesPaid, 9);
    expect(s.roundTrips).toBe(bt.roundTrips);
  });

  it("un prix refusé saute le tick sans alimenter la stratégie", async () => {
    const fail = new Set([20, 21, 90]);
    const t = PaperTrader.open(opts(new SeriesSource(prices, fail)));
    await ticks(t, 300);
    const used = prices.filter((_, i) => !fail.has(i)).slice(0, t.status().ticks);
    const bt = runBacktest(used, mk());
    expect(t.status().skipped).toBe(3);
    expect(t.status().equity).toBeCloseTo(bt.finalEquity, 9);
  });

  it("saute un prix périmé", async () => {
    const t = PaperTrader.open(opts(new SeriesSource(prices, new Set(), 600)));
    const r = await t.tick();
    expect(r.status).toBe("skipped");
    expect(r.status === "skipped" && r.reason).toMatch(/périmé/);
    expect(t.status().ticks).toBe(0);
  });

  it("un redémarrage au milieu ne change rien au résultat", async () => {
    const single = PaperTrader.open(opts(new SeriesSource(prices)));
    await ticks(single, 300);

    const src = new SeriesSource(prices);
    const o = opts(src);
    const first = PaperTrader.open(o);
    await ticks(first, 137); // arrêt en cours de route…
    const second = PaperTrader.open(o); // …puis reprise depuis le fichier d'état
    await ticks(second, 163);

    expect(second.status().equity).toBeCloseTo(single.status().equity, 9);
    expect(second.status().trades).toBe(single.status().trades);
    expect(second.status().ticks).toBe(300);
  });

  it("refuse de reprendre un état d'une autre configuration", async () => {
    const o = opts(new SeriesSource(prices));
    await ticks(PaperTrader.open(o), 5);
    expect(() => PaperTrader.open({ ...o, symbol: "BTC" })).toThrow(/pas BTC/);
    expect(() => PaperTrader.open({ ...o, makeStrategy: () => new SmaCrossover(4, 9) })).toThrow(/--reset/);
    expect(() => PaperTrader.open({ ...o, exec: { feeRate: 0.01 } })).toThrow(/feeRate/);
    const fresh = PaperTrader.open({ ...o, symbol: "BTC", reset: true });
    expect(fresh.status().ticks).toBe(0);
  });

  it("le kill switch arrête tout", async () => {
    const o = opts(new SeriesSource(prices));
    const t = PaperTrader.open(o);
    await t.tick();
    writeFileSync(o.killSwitchPath!, "");
    const r = await t.tick();
    expect(r.status).toBe("stopped");
    expect(t.status().ticks).toBe(1);
  });

  it("journalise les ticks, les trades et les ticks sautés", async () => {
    const o = opts(new SeriesSource(prices, new Set([3])));
    const t = PaperTrader.open(o);
    await ticks(t, 200);
    const events = readFileSync(o.journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const kinds = new Set(events.map((e) => e.event));
    expect(kinds).toEqual(new Set(["tick", "trade", "skipped"]));
    expect(events.filter((e) => e.event === "trade").length).toBe(t.status().trades);
  });

  it("n'écrit pas d'état avant le premier tick réussi (status à froid)", () => {
    const o = opts(new SeriesSource(prices));
    const t = PaperTrader.open(o);
    expect(existsSync(o.statePath)).toBe(false);
    expect(t.status().equity).toBe(1000);
    expect(t.status().buyHoldReturnPct).toBeNull();
  });

  it("refuse un état corrompu", async () => {
    const o = opts(new SeriesSource(prices));
    await ticks(PaperTrader.open(o), 3);
    const st = JSON.parse(readFileSync(o.statePath, "utf8"));
    st.portfolio.cash = -5;
    writeFileSync(o.statePath, JSON.stringify(st));
    expect(() => PaperTrader.open(o)).toThrow(/corrompu/);
  });
});

describe("runPaper", () => {
  it("s'arrête après maxTicks et attend l'intervalle entre deux prix", async () => {
    const waits: number[] = [];
    const t = PaperTrader.open(opts(new SeriesSource(prices)));
    await runPaper(t, { intervalSec: 30, maxTicks: 4, sleep: async (ms) => void waits.push(ms), log: () => {} });
    expect(t.status().ticks).toBe(4);
    expect(waits).toEqual([30000, 30000, 30000]); // pas d'attente après le dernier
  });
  it("s'arrête après trop de ticks sautés d'affilée", async () => {
    const t = PaperTrader.open(opts(new SeriesSource(prices, new Set(Array.from({ length: 50 }, (_, i) => i)))));
    const logs: string[] = [];
    await runPaper(t, { intervalSec: 1, maxTicks: 50, maxConsecutiveSkips: 3, sleep: async () => {}, log: (s) => logs.push(s) });
    expect(t.status().skipped).toBe(3);
    expect(logs.at(-1)).toMatch(/3 ticks sautés/);
  });
  it("respecte shouldStop", async () => {
    const t = PaperTrader.open(opts(new SeriesSource(prices)));
    let n = 0;
    await runPaper(t, { intervalSec: 1, sleep: async () => {}, log: () => {}, shouldStop: () => n++ >= 2 });
    expect(t.status().ticks).toBe(2);
  });
});

describe("CLI papier", () => {
  it("affiche l'aide", async () => {
    const out: string[] = [];
    await paperCommand(["--help"], (s) => out.push(s));
    expect(out.join()).toMatch(/Usage/);
  });
  it("refuse un intervalle trop court", async () => {
    await expect(paperCommand(["--interval", "1"], () => {})).rejects.toThrow(/minimum/);
  });
  it("refuse un symbole invalide", async () => {
    await expect(paperCommand(["--symbol", "ETH&x=1"], () => {})).rejects.toThrow(/invalide/);
  });
  it("formate le statut", async () => {
    const t = PaperTrader.open(opts(new SeriesSource(prices)));
    await ticks(t, 50);
    expect(formatStatus(t.status())).toMatch(/capital : .* USD/);
  });
});

describe("CLI papier : choix de la stratégie", () => {
  it("accepte --strategy zrev et refuse une stratégie inconnue avant toute requête", async () => {
    await expect(paperCommand(["--strategy", "magic"], () => {})).rejects.toThrow(/stratégie inconnue/);
    await expect(paperCommand(["--strategy", "zrev", "--window", "3"], () => {})).rejects.toThrow(/window/);
  });
});
