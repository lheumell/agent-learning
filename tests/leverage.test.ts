import { describe, expect, it } from "vitest";
import { DEFAULT_LEVERAGE, liquidationPrice, simulateLeveraged, summarize, validateLeverage, type LeverageConfig } from "../src/leverage.js";
import { ruinCommand } from "../src/ruin-cli.js";
import { syntheticPrices } from "../src/simulate.js";

// Capital 2000, marge 100 (5 %), levier 5 : notionnel 500, quantité 5 à 100, liquidation à 80 (-20 %). Sans frais.
const base: Partial<LeverageConfig> = {
  walletUsd: 2000, stakeFraction: 0.05, leverage: 5, takeProfitPct: 0.01, feeRate: 0, maintenanceRate: 0,
  cooldownBars: 50, maxHoldBars: 1000, reinjectTrigger: 0.03, // délai long : une seule position par trajet court
};
const run = (prices: number[], o: Partial<LeverageConfig> = {}) => simulateLeveraged(prices, { ...base, ...o });

describe("liquidationPrice", () => {
  it("vaut -20 % pour un levier 5 sans marge de maintenance", () => {
    expect(liquidationPrice(100, 5, 100, 0)).toBeCloseTo(80, 9);
  });
  it("monte avec la marge de maintenance", () => {
    expect(liquidationPrice(100, 5, 100, 0.01)).toBeGreaterThan(80);
  });
  it("devient 0 quand la marge couvre tout le notionnel (plus de liquidation possible)", () => {
    expect(liquidationPrice(500, 5, 100, 0)).toBe(0);
    expect(liquidationPrice(2000, 5, 100, 0)).toBe(0);
  });
});

describe("simulateLeveraged : mécanique", () => {
  it("prise de gain : +1 % de prix sur 5 unités = +5", () => {
    const r = run([100, 101, 102], { policy: "bounded" });
    expect(r.finalWallet).toBeCloseTo(2005, 9);
    expect(r.wins).toBe(1);
    expect(r.trades).toBe(1);
  });
  it("bounded sans stop : la liquidation coûte exactement la marge", () => {
    const r = run([100, 90, 79], { policy: "bounded", stopLossPct: 0.99 });
    expect(r.finalWallet).toBeCloseTo(1900, 9);
    expect(r.liquidations).toBe(1);
  });
  it("bounded avec stop : perte = notionnel x stop, connue d'avance", () => {
    const r = run([100, 95, 94], { policy: "bounded", stopLossPct: 0.05 }); // stop à 95 : perte 5 x 5 = 25
    expect(r.finalWallet).toBeCloseTo(1975, 9);
    expect(r.stops).toBe(1);
    expect(r.liquidations).toBe(0);
  });
  it("reinject : la réinjection évite la liquidation et la prise de gain finit par arriver", () => {
    const r = run([100, 82, 90, 101], { policy: "reinject" });
    expect(r.reinjections).toBe(1);
    expect(r.liquidations).toBe(0);
    expect(r.finalWallet).toBeCloseTo(2005, 9); // gain identique à un trade sans histoire
    expect(r.wins).toBe(1);
  });
  it("reinject : à son pire moment, tout le capital est engagé dans la position", () => {
    const r = run([100, 82, 90, 101], { policy: "reinject" });
    expect(r.peakAtRiskPct).toBeCloseTo(100, 9); // tout le capital libre a été injecté
    expect(r.peakAtRiskPct).toBeLessThanOrEqual(100);
    expect(run([100, 101], { policy: "bounded" }).peakAtRiskPct).toBeCloseTo(5, 9); // la marge initiale, rien de plus
  });
  it("reinject : une baisse durable immobilise le capital au lieu de le liquider (position ouverte à la fin)", () => {
    const r = run([100, 82, 60, 50, 40], { policy: "reinject" });
    expect(r.liquidations).toBe(0);
    expect(r.openAtEnd).toBe(true);
    expect(r.finalWallet).toBeCloseTo(2000 + 5 * (40 - 100), 9); // 1700 : perte latente du notionnel
    expect(r.maxDrawdownPct).toBeGreaterThan(10);
  });
  it("reinject : si le notionnel dépasse le capital, la ruine est possible malgré la réinjection", () => {
    // marge 400 (20 %) x levier 10 : notionnel 4000 = 2x le capital de 2000. À 91, on réinjecte tout (marge 2000),
    // mais la liquidation recule seulement à 50 : le prix passe à 40, et tout est perdu.
    const r = run([100, 91, 70, 40, 10, 1], { policy: "reinject", stakeFraction: 0.2, leverage: 10 });
    expect(r.reinjections).toBe(1);
    expect(r.liquidations).toBe(1);
    expect(r.finalWallet).toBeCloseTo(0, 9);
  });
  it("reinject : un prix qui saute au-delà de la zone de réinjection est liquidé sans pouvoir réagir (risque de saut)", () => {
    const r = run([100, 93, 70], { policy: "reinject", stakeFraction: 0.2, leverage: 10 });
    expect(r.reinjections).toBe(0);
    expect(r.liquidations).toBe(1);
    expect(r.finalWallet).toBeCloseTo(2000 - 400, 9);
  });
  it("applique les frais à l'ouverture et à la clôture", () => {
    const r = run([100, 101, 102], { policy: "bounded", feeRate: 0.001 });
    expect(r.finalWallet).toBeLessThan(2005);
    expect(r.finalWallet).toBeGreaterThan(2000);
  });
  it("clôture au marché après maxHoldBars", () => {
    const r = run([100, 99.9, 99.8, 99.7, 99.6, 99.5], { policy: "bounded", stopLossPct: 0.5, maxHoldBars: 3 });
    expect(r.timeouts).toBe(1);
    expect(r.trades).toBeGreaterThanOrEqual(1);
  });
  it("n'ouvre pas de position sur la dernière barre", () => {
    expect(run([100, 100]).trades).toBe(0);
  });
  it("respecte le délai entre deux positions", () => {
    const quick = run([100, 101, 101, 102, 103, 104, 105], { policy: "bounded", cooldownBars: 0 });
    const slow = run([100, 101, 101, 102, 103, 104, 105], { policy: "bounded", cooldownBars: 3 });
    expect(quick.trades).toBeGreaterThan(slow.trades);
  });
  it("est déterministe", () => {
    const p = syntheticPrices({ n: 1500, seed: 9, vol: 0.007 });
    expect(simulateLeveraged(p)).toEqual(simulateLeveraged(p));
  });
  it("conserve l'argent : un trajet plat sans frais ne gagne ni ne perd", () => {
    expect(run(Array(100).fill(100), { policy: "reinject" }).finalWallet).toBeCloseTo(2000, 9);
  });
});

describe("validation", () => {
  it("refuse les paramètres absurdes", () => {
    const bad: Partial<LeverageConfig>[] = [{ walletUsd: 0 }, { stakeFraction: 0 }, { stakeFraction: 1.5 }, { leverage: 0.5 }, { takeProfitPct: 0 }, { feeRate: -1 }, { maintenanceRate: 0.6 }, { stopLossPct: 1.2 }, { reinjectTrigger: 1 }, { reinjectFraction: 0 }, { maxHoldBars: 0 }, { cooldownBars: -1 }, { policy: "x" as any }];
    for (const b of bad) expect(() => validateLeverage({ ...DEFAULT_LEVERAGE, ...b }), JSON.stringify(b)).toThrow();
    expect(() => simulateLeveraged([100])).toThrow(/2 prix/);
    expect(() => simulateLeveraged([100, NaN])).toThrow(/invalide/);
  });
});

describe("summarize", () => {
  it("agrège les trajectoires", () => {
    const rs = [100, 200, 300].map((w) => ({ ...run([100, 101, 102]), finalWallet: w * 10 }));
    const s = summarize(rs, 2000);
    expect(s.paths).toBe(3);
    // capitaux finaux 1000, 2000, 3000 pour un départ à 2000 : -50 %, 0 %, +50 %
    expect(s.medianFinalPct).toBeCloseTo(0, 9);
    expect(s.meanFinalPct).toBeCloseTo(0, 9);
    expect(s.profitablePct).toBeCloseTo(100 / 3, 9);
    expect(s.loss50Pct).toBeCloseTo(100 / 3, 9);
    expect(s.loss90Pct).toBe(0);
    expect(() => summarize([], 100)).toThrow(/aucune/);
  });
});

describe("ruinCommand", () => {
  const run2 = (args: string[]) => {
    const out: string[] = [];
    ruinCommand(args, (s) => out.push(s));
    return out.join("\n");
  };
  it("compare les deux politiques", () => {
    const txt = run2(["--seeds", "20", "--n", "1500"]);
    expect(txt).toMatch(/réinjecte à fond/);
    expect(txt).toMatch(/risque borné/);
    expect(txt).toMatch(/Référence : garder/);
  });
  it("avertit quand l'exposition dépasse le capital", () => {
    expect(run2(["--seeds", "5", "--n", "800", "--stake", "0.2", "--leverage", "10"])).toMatch(/Exposition > 100 %/);
    expect(run2(["--seeds", "5", "--n", "800", "--stake", "0.05", "--leverage", "5"])).not.toMatch(/Exposition > 100 %/);
  });
  it("valide les arguments", () => {
    expect(() => run2(["--policy", "x"])).toThrow(/--policy/);
    expect(() => run2(["--leverage", "abc"])).toThrow(/nombre/);
    expect(run2(["--help"])).toMatch(/Usage/);
  });
});

describe("constats sur marche aléatoire (sans aucun avantage)", () => {
  const summaries = (cfg: Partial<LeverageConfig>, drift = 0) => {
    const paths = Array.from({ length: 100 }, (_, i) => syntheticPrices({ n: 4000, seed: i + 1, vol: 0.007, drift }));
    const s = (policy: "reinject" | "bounded") =>
      summarize(paths.map((p) => simulateLeveraged(p, { ...DEFAULT_LEVERAGE, ...cfg, policy })), DEFAULT_LEVERAGE.walletUsd);
    return { reinject: s("reinject"), bounded: s("bounded") };
  };

  it("réinjecter donne presque que des positions gagnantes, et pourtant le capital médian baisse", () => {
    const { reinject } = summaries({ stakeFraction: 0.1, leverage: 10 });
    expect(reinject.tradeWinRatePct!).toBeGreaterThan(90);
    expect(reinject.medianFinalPct).toBeLessThan(0);
  });
  it("réinjecter engage tout le capital dans la position au pire moment, le risque borné jamais", () => {
    const { reinject, bounded } = summaries({ stakeFraction: 0.1, leverage: 10 });
    expect(reinject.medianPeakAtRiskPct).toBeCloseTo(100, 9);
    expect(bounded.worstPeakAtRiskPct).toBeLessThan(10.1); // la marge initiale (10 %), aux frais d'ouverture près
  });
  it("réinjecter immobilise une position pendant toute la durée autorisée dans la moitié des cas", () => {
    const { reinject, bounded } = summaries({ stakeFraction: 0.1, leverage: 10 });
    expect(reinject.medianLongestHoldBars).toBeGreaterThanOrEqual(1999);
    expect(bounded.medianLongestHoldBars).toBeLessThan(500);
  });
  it("au-delà de 100 % d'exposition, réinjecter fait bien plus de ruines que le risque borné", () => {
    const { reinject, bounded } = summaries({ stakeFraction: 0.2, leverage: 10 });
    expect(reinject.loss90Pct).toBeGreaterThan(bounded.loss90Pct + 5);
    expect(reinject.liquidatedPct).toBeGreaterThan(5);
    expect(bounded.liquidatedPct).toBe(0);
  });
  it("le risque borné n'est PAS plus rentable : sans avantage, aucune structure de stop ne crée de gain", () => {
    const { bounded } = summaries({ stakeFraction: 0.1, leverage: 10 });
    expect(bounded.medianFinalPct).toBeLessThan(0);
  });
  it("dans un marché haussier, garder sans levier bat les deux (les gains viennent du marché, pas de la méthode)", () => {
    const drift = 0.0001;
    const { reinject, bounded } = summaries({ stakeFraction: 0.1, leverage: 10 }, drift);
    const paths = Array.from({ length: 100 }, (_, i) => syntheticPrices({ n: 4000, seed: i + 1, vol: 0.007, drift }));
    const holds = paths.map((p) => (p[p.length - 1] / p[0] - 1) * 100).sort((a, b) => a - b);
    const holdMedian = holds[50];
    expect(reinject.medianFinalPct).toBeGreaterThan(0);
    expect(holdMedian).toBeGreaterThan(reinject.medianFinalPct);
    expect(holdMedian).toBeGreaterThan(bounded.medianFinalPct);
  });
});
