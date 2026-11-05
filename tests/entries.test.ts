import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BreakoutRule, DipRule, RandomRule } from "../src/entries.js";
import { evaluateRule, entryCommand } from "../src/entry-cli.js";
import { DEFAULT_LEVERAGE, liquidationPrice, simulateLeveraged, type EntryRule, type EntrySignal, type LeverageConfig } from "../src/leverage.js";
import { syntheticPrices } from "../src/simulate.js";

const feed = (rule: EntryRule, prices: number[]) => prices.map((p) => rule.onPrice(p));

describe("DipRule", () => {
  it("achète après une baisse d'au moins dropPct sous le plus haut récent", () => {
    expect(feed(new DipRule(3, 0.1, "long"), [100, 100, 100, 89])).toEqual([null, null, null, "long"]);
    expect(feed(new DipRule(3, 0.1, "long"), [100, 100, 100, 91])[3]).toBeNull(); // baisse insuffisante
  });
  it("vend à découvert après une hausse d'au moins dropPct (mode both), jamais en mode long", () => {
    expect(feed(new DipRule(3, 0.1, "both"), [100, 100, 100, 111])[3]).toBe("short");
    expect(feed(new DipRule(3, 0.1, "long"), [100, 100, 100, 111])[3]).toBeNull();
  });
  it("reste muet tant que la fenêtre n'est pas remplie", () => {
    expect(feed(new DipRule(5, 0.05), [100, 50, 30, 20])).toEqual([null, null, null, null]);
  });
  it("ne donne aucun signal quand achat et vente seraient possibles en même temps", () => {
    expect(feed(new DipRule(3, 0.1, "both"), [100, 50, 100, 60])[3]).toBeNull();
  });
  it("n'utilise que le passé : la fenêtre exclut le prix courant", () => {
    const a = new DipRule(3, 0.1, "long");
    feed(a, [100, 100, 100]);
    expect(a.onPrice(80)).toBe("long");
    expect(a.onPrice(80)).toBe("long"); // 80 reste sous 90 % de 100 : la fenêtre contient 100, 100, 80
  });
  it("valide ses paramètres", () => {
    expect(() => new DipRule(1)).toThrow(/lookback/);
    expect(() => new DipRule(5, 0)).toThrow(/dropPct/);
    expect(() => new DipRule(5, 1)).toThrow(/dropPct/);
    expect(() => new DipRule(5, 0.1, "x" as any)).toThrow(/sides/);
  });
});

describe("BreakoutRule", () => {
  it("achète quand le prix dépasse le plus haut des barres précédentes", () => {
    expect(feed(new BreakoutRule(3, "both"), [100, 101, 102, 103])).toEqual([null, null, null, "long"]);
    expect(feed(new BreakoutRule(3, "both"), [100, 101, 102, 102])[3]).toBeNull(); // égalité : pas de cassure
  });
  it("vend à découvert quand le prix passe sous le plus bas, seulement en mode both", () => {
    expect(feed(new BreakoutRule(3, "both"), [100, 99, 98, 97])[3]).toBe("short");
    expect(feed(new BreakoutRule(3, "long"), [100, 99, 98, 97])[3]).toBeNull();
  });
  it("valide ses paramètres", () => {
    expect(() => new BreakoutRule(1)).toThrow(/lookback/);
    expect(() => new BreakoutRule(5, "x" as any)).toThrow(/sides/);
  });
});

describe("RandomRule", () => {
  it("est déterministe pour une graine et approche la fréquence demandée", () => {
    const sig = (seed: number) => feed(new RandomRule(0.1, seed, "both"), Array(5000).fill(1));
    expect(sig(3)).toEqual(sig(3));
    expect(sig(3)).not.toEqual(sig(4));
    const rate = sig(3).filter(Boolean).length / 5000;
    expect(rate).toBeGreaterThan(0.08);
    expect(rate).toBeLessThan(0.12);
  });
  it("mélange achats et ventes à découvert à parts égales, ou achats seulement", () => {
    const both = feed(new RandomRule(1, 5, "both"), Array(2000).fill(1));
    const longs = both.filter((s) => s === "long").length;
    expect(longs).toBeGreaterThan(900);
    expect(longs).toBeLessThan(1100);
    expect(feed(new RandomRule(1, 5, "long"), Array(50).fill(1)).every((s) => s === "long")).toBe(true);
  });
  it("valide prob et sides", () => {
    expect(() => new RandomRule(-0.1, 1)).toThrow(/prob/);
    expect(() => new RandomRule(1.1, 1)).toThrow(/prob/);
  });
});

// Capital 2000, marge 100 (5 %), levier 5 : notionnel 500, quantité 5 à 100.
const base: Partial<LeverageConfig> = {
  walletUsd: 2000, stakeFraction: 0.05, leverage: 5, takeProfitPct: 0.01, feeRate: 0, maintenanceRate: 0,
  cooldownBars: 50, maxHoldBars: 1000, reinjectTrigger: 0.03,
};
const scripted = (signals: Record<number, EntrySignal>): EntryRule => {
  let i = -1;
  return { name: "scripted", onPrice: () => signals[++i] ?? null };
};
const run = (prices: number[], rule: EntryRule, o: Partial<LeverageConfig> = {}) => simulateLeveraged(prices, { ...base, ...o }, rule);

describe("positions à la vente (short)", () => {
  it("le prix de liquidation d'un short est au-dessus de l'entrée (+20 % à levier 5)", () => {
    expect(liquidationPrice(100, 5, 100, 0, "short")).toBeCloseTo(120, 9);
    expect(liquidationPrice(100, 5, 100, 0.01, "short")).toBeLessThan(120);
  });
  it("gagne quand le prix baisse : -1 % sur 5 unités = +5", () => {
    const r = run([100, 100, 99, 98], scripted({ 0: "short" }), { policy: "bounded" });
    expect(r.shorts).toBe(1);
    expect(r.finalWallet).toBeCloseTo(2005, 9);
  });
  it("est liquidé quand le prix monte de 20 % : perte = la marge", () => {
    const r = run([100, 100, 110, 121], scripted({ 0: "short" }), { policy: "bounded", stopLossPct: 0.99 });
    expect(r.liquidations).toBe(1);
    expect(r.finalWallet).toBeCloseTo(1900, 9);
  });
  it("stop d'un short : déclenché par une hausse, perte = notionnel x stop", () => {
    const r = run([100, 100, 105, 106], scripted({ 0: "short" }), { policy: "bounded", stopLossPct: 0.05 });
    expect(r.stops).toBe(1);
    expect(r.finalWallet).toBeCloseTo(1975, 9);
  });
  it("réinjection d'un short quand le prix monte vers la liquidation", () => {
    const r = run([100, 100, 118, 105, 99], scripted({ 0: "short" }), { policy: "reinject" });
    expect(r.reinjections).toBe(1);
    expect(r.liquidations).toBe(0);
    expect(r.finalWallet).toBeCloseTo(2005, 9);
  });
});

describe("règle d'entrée dans le simulateur", () => {
  it("exécute au prix de la barre SUIVANT le signal (pas d'anticipation)", () => {
    // signal à la barre 1 (prix 100) -> entrée à la barre 2 (prix 200) ; cible +1 % = 202 ; quantité 2,5 ; gain 5
    const r = run([100, 100, 200, 202, 203], scripted({ 1: "long" }), { policy: "bounded" });
    expect(r.entries).toBe(1);
    expect(r.finalWallet).toBeCloseTo(2005, 9); // si l'entrée se faisait à 100, la cible serait déjà atteinte à 200
  });
  it("ignore un signal reçu pendant une position ouverte ou le délai d'attente", () => {
    const r = run([100, 100, 100, 100, 100, 100], scripted({ 1: "long", 2: "short", 3: "long" }), { policy: "bounded" });
    expect(r.entries).toBe(1);
  });
  it("n'ouvre pas sur la dernière barre", () => {
    const r = run([100, 100, 100], scripted({ 1: "long" }), { policy: "bounded" });
    expect(r.entries).toBe(0);
  });
  it("compte les barres disponibles et les signaux vus", () => {
    const r = run([100, 100, 100, 100, 100], scripted({ 1: "long", 3: "long" }), { policy: "bounded", cooldownBars: 0 });
    expect(r.eligibleBars).toBeGreaterThan(0);
    expect(r.signalsEligible).toBeGreaterThanOrEqual(1);
    expect(r.signalsEligible).toBeLessThanOrEqual(r.eligibleBars);
  });
  it("sans règle, le comportement historique est conservé (entrée sur la même barre)", () => {
    expect(simulateLeveraged([100, 101, 102], { ...base, policy: "bounded" }).finalWallet).toBeCloseTo(2005, 9);
  });
});

describe("modèle de tendances (mom)", () => {
  it("est déterministe et strictement positif", () => {
    const a = syntheticPrices({ n: 800, seed: 2, model: "mom" });
    expect(a).toEqual(syntheticPrices({ n: 800, seed: 2, model: "mom" }));
    expect(a.every((p) => p > 0 && Number.isFinite(p))).toBe(true);
  });
  it("produit de longues phases : les blocs consécutifs de 40 barres sont corrélés, pas sur une marche aléatoire", () => {
    const blockAutocorr = (p: number[], w: number) => {
      const r = p.slice(1).map((x, i) => Math.log(x / p[i]));
      const m = Math.floor(r.length / w);
      const b = Array.from({ length: m }, (_, i) => r.slice(i * w, (i + 1) * w).reduce((a, c) => a + c, 0) / w);
      const mean = b.reduce((a, c) => a + c, 0) / m;
      let num = 0;
      let den = 0;
      for (let i = 0; i < m; i++) {
        den += (b[i] - mean) ** 2;
        if (i > 0) num += (b[i] - mean) * (b[i - 1] - mean);
      }
      return num / den;
    };
    for (const seed of [1, 2, 3]) {
      expect(blockAutocorr(syntheticPrices({ n: 60000, seed, vol: 0.007, model: "mom" }), 40)).toBeGreaterThan(0.15); // mesuré : 0,24 à 0,29
      expect(Math.abs(blockAutocorr(syntheticPrices({ n: 60000, seed, vol: 0.007, model: "gbm" }), 40))).toBeLessThan(0.1); // mesuré : < 0,04
    }
  });
  it("valide phi et trend", () => {
    expect(() => syntheticPrices({ n: 10, seed: 1, model: "mom", phi: 1 })).toThrow(/phi/);
    expect(() => syntheticPrices({ n: 10, seed: 1, model: "mom", trend: -1 })).toThrow(/trend/);
  });
});

describe("la règle bat-elle le hasard ? (cas témoins)", () => {
  const cfg: LeverageConfig = { ...DEFAULT_LEVERAGE, policy: "bounded", stakeFraction: 0.1, leverage: 5, takeProfitPct: 0.05 };
  const paths = (model: "gbm" | "ou" | "mom", n: number, vol: number, seed0 = 1) =>
    Array.from({ length: n }, (_, i) => syntheticPrices({ n: 4000, seed: seed0 + i, vol, model }));

  it("POSITIF : « achat après une baisse » bat le hasard sur un marché qui revient à la moyenne", () => {
    const e = evaluateRule(paths("ou", 25, 0.01), { ...cfg, takeProfitPct: 0.03 }, () => new DipRule(24, 0.04, "both"), "both", 20);
    expect(e.meanBeatPct).toBeGreaterThan(85);
    expect(e.strongPct).toBeGreaterThan(70);
  });
  it("POSITIF : la cassure bat le hasard sur un marché à tendances", () => {
    const e = evaluateRule(paths("mom", 25, 0.007), cfg, () => new BreakoutRule(24, "both"), "both", 20);
    expect(e.meanBeatPct).toBeGreaterThan(75);
    expect(e.rule.medianFinalPct).toBeGreaterThan(e.random.medianFinalPct);
  });
  it("INVERSE : « achat après une baisse » fait PIRE que le hasard sur un marché à tendances", () => {
    const e = evaluateRule(paths("mom", 25, 0.007), cfg, () => new DipRule(24, 0.04, "both"), "both", 20);
    expect(e.meanBeatPct).toBeLessThan(30);
    expect(e.weakPct).toBeGreaterThan(20);
  });
  it("NÉGATIF : sur une marche aléatoire, aucune des deux règles ne se distingue du hasard", () => {
    const g = paths("gbm", 40, 0.007, 500);
    const dip = evaluateRule(g, cfg, () => new DipRule(24, 0.04, "both"), "both", 20);
    const brk = evaluateRule(g, cfg, () => new BreakoutRule(24, "both"), "both", 20);
    for (const e of [dip, brk]) {
      expect(e.meanBeatPct).toBeGreaterThan(35);
      expect(e.meanBeatPct).toBeLessThan(65);
      expect(e.strongPct).toBeLessThan(25);
    }
  });
});

describe("entryCommand", () => {
  const run2 = (args: string[], deps = {}) => {
    const out: string[] = [];
    entryCommand(args, (s) => out.push(s), deps);
    return out.join("\n");
  };
  it("affiche l'aide et exige une règle", () => {
    expect(run2(["--help"])).toMatch(/RÈGLE D'ENTRÉE/);
    expect(() => run2([])).toThrow(/--rule/);
    expect(() => run2(["--rule", "magic"])).toThrow(/--rule/);
  });
  it("compare la règle au hasard pour les deux politiques", () => {
    const txt = run2(["--rule", "dip", "--seeds", "4", "--n", "1200", "--random", "6"]);
    expect(txt).toMatch(/DIP\(48\/0\.04\/both\)/);
    expect(txt).toMatch(/on réinjecte à fond/);
    expect(txt).toMatch(/risque borné/);
    expect(txt).toMatch(/Percentile moyen/);
  });
  it("valide les paramètres", () => {
    expect(() => run2(["--rule", "dip", "--drop", "2"])).toThrow(/dropPct/);
    expect(() => run2(["--rule", "breakout", "--lookback", "1"])).toThrow(/lookback/);
    expect(() => run2(["--rule", "dip", "--policy", "x"])).toThrow(/--policy/);
    expect(() => run2(["--rule", "dip", "--tp", "abc"])).toThrow(/nombre/);
  });

  const prices = syntheticPrices({ n: 3000, seed: 8, model: "mom" });
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "entry-"));
    const csv = join(dir, "p.csv");
    writeFileSync(csv, "close\n" + prices.join("\n") + "\n");
    return { csv, logPath: join(dir, "log.json") };
  };
  it("--holdout travaille sans la période réservée ; --final l'évalue et compte les regards", () => {
    const { csv, logPath } = setup();
    const dev = run2(["--rule", "breakout", "--csv", csv, "--holdout", "0.2", "--n", "5000", "--random", "10"], { logPath });
    expect(dev).toMatch(/partie développement \(2400 barres ; 600 barres réservées, non utilisées\)/);
    const first = run2(["--rule", "breakout", "--csv", csv, "--final", "--n", "5000", "--random", "10"], { logPath });
    expect(first).toMatch(/PÉRIODE RÉSERVÉE \(600 barres/);
    expect(first).toMatch(/1er regard/);
    expect(run2(["--rule", "breakout", "--csv", csv, "--final", "--n", "5000", "--random", "10"], { logPath })).toMatch(/2e regard/);
  });
  it("avertit que des fenêtres de vrais prix qui se recouvrent ne sont pas indépendantes", () => {
    const { csv } = setup();
    expect(run2(["--rule", "dip", "--csv", csv, "--n", "1500", "--random", "5"])).toMatch(/se recouvrent/);
  });
});
