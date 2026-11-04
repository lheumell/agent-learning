import { describe, expect, it } from "vitest";
import { maxDrawdownPct, runBacktest } from "../src/backtest.js";
import type { Signal, Strategy } from "../src/strategy.js";

/** Stratégie scriptée : rend le signal prévu pour chaque barre. */
const scripted = (signals: Signal[]): Strategy => {
  let i = 0;
  return { name: "scripted", onPrice: () => signals[i++] ?? "hold" };
};
const FREE = { feeRate: 0, slippageRate: 0 };

describe("runBacktest", () => {
  it("exécute au prix de la barre SUIVANTE (pas de biais d'anticipation)", () => {
    // Signal d'achat après la barre 0 (prix 100) : l'exécution doit se faire à 200.
    const r = runBacktest([100, 200, 200], scripted(["buy"]), { ...FREE, initialCashUsd: 1000 });
    expect(r.trades[0].index).toBe(1);
    expect(r.trades[0].price).toBe(200);
    expect(r.finalEquity).toBeCloseTo(1000, 6); // 5 unités à 200. Avec anticipation : 2000.
  });
  it("sans trade, le capital ne bouge pas", () => {
    const r = runBacktest([100, 90, 80], scripted([]), FREE);
    expect(r.finalEquity).toBe(1000);
    expect(r.returnPct).toBe(0);
    expect(r.winRate).toBeNull();
  });
  it("applique les frais (aller-retour à prix constant)", () => {
    const r = runBacktest([100, 100, 100, 100], scripted(["buy", "sell"]), { feeRate: 0.001, slippageRate: 0 });
    expect(r.finalEquity).toBeCloseTo((1000 / 1.001) * 0.999, 6);
    expect(r.feesPaid).toBeCloseTo(1000 - r.finalEquity, 6);
    expect(r.roundTrips).toBe(1);
    expect(r.winRate).toBe(0);
  });
  it("le slippage est toujours défavorable", () => {
    const r = runBacktest([100, 100, 100, 100], scripted(["buy", "sell"]), { feeRate: 0, slippageRate: 0.01 });
    expect(r.trades[0].price).toBeCloseTo(101, 6);
    expect(r.trades[1].price).toBeCloseTo(99, 6);
    expect(r.finalEquity).toBeLessThan(1000);
  });
  it("ignore un achat déjà en position et une vente sans position", () => {
    const r = runBacktest([100, 100, 100, 100, 100], scripted(["sell", "buy", "buy"]), FREE);
    expect(r.trades.map((t) => t.side)).toEqual(["buy"]);
  });
  it("calcule le taux de réussite sur les allers-retours terminés", () => {
    const prices = [100, 100, 120, 120, 100, 100, 90, 90];
    const sig: Signal[] = ["buy", "hold", "sell", "hold", "buy", "hold", "sell"];
    const r = runBacktest(prices, scripted(sig), FREE);
    expect(r.roundTrips).toBe(2);
    expect(r.winRate).toBe(0.5);
  });
  it("signale une position ouverte à la fin", () => {
    const r = runBacktest([100, 100, 110], scripted(["buy"]), FREE);
    expect(r.openPosition).toBe(true);
    expect(r.finalEquity).toBeCloseTo(1100, 6);
  });
  it("acheter-garder : +10 % si le prix monte de 10 %, sans frais", () => {
    expect(runBacktest([100, 110], scripted([]), FREE).buyHoldReturnPct).toBeCloseTo(10, 9);
  });
  it("l'allocation laisse une part du capital en cash", () => {
    const r = runBacktest([100, 100, 200], scripted(["buy"]), { ...FREE, allocation: 0.5 });
    expect(r.finalEquity).toBeCloseTo(500 + 500 * 2, 6);
  });
  it("valide les entrées", () => {
    expect(() => runBacktest([100], scripted([]))).toThrow(/2 prix/);
    expect(() => runBacktest([100, NaN], scripted([]))).toThrow(/invalide/);
    expect(() => runBacktest([100, 100], scripted([]), { allocation: 0 })).toThrow(/allocation/);
    expect(() => runBacktest([100, 100], scripted([]), { feeRate: 1 })).toThrow(/frais/);
  });
});

describe("maxDrawdownPct", () => {
  it("mesure la pire chute depuis un sommet", () => {
    expect(maxDrawdownPct([100, 120, 60, 90])).toBeCloseTo(50, 9);
  });
  it("vaut 0 sur une courbe croissante", () => {
    expect(maxDrawdownPct([1, 2, 3])).toBe(0);
  });
});

describe("Portfolio : arrondis", () => {
  it("ne laisse jamais un solde négatif après un achat en pleine allocation", async () => {
    const { Portfolio } = await import("../src/portfolio.js");
    for (const fee of [0, 0.001, 0.0033, 0.01]) {
      for (const price of [0.1, 3, 1234.5678, 99999.99]) {
        const pf = new Portfolio({ initialCashUsd: 1000, feeRate: fee, slippageRate: 0.0005, allocation: 1 });
        pf.buy(price, 0);
        expect(pf.cash).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
