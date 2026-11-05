import { describe, expect, it } from "vitest";
import { DipRule } from "../src/entries.js";
import { entryCommand, evaluateRule } from "../src/entry-cli.js";
import { DEFAULT_LEVERAGE, simulateLeveraged, type EntryRule, type EntrySignal, type LeverageConfig } from "../src/leverage.js";
import { EfficiencyGate, GatedRule, VolatilityGate, makeGateFactory, parseGateName } from "../src/regimes.js";
import { syntheticPrices } from "../src/simulate.js";

const feedGate = (g: { update(p: number): void; isOpen(): boolean }, prices: number[]) =>
  prices.map((p) => {
    g.update(p);
    return g.isOpen();
  });
const zigzag = (n: number, amp: number, start = 100) => {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + (i % 2 ? amp : -amp)));
  return out;
};

describe("EfficiencyGate", () => {
  it("vaut 1 pour une ligne droite et 0 pour un aller-retour", () => {
    const g1 = new EfficiencyGate(5, "trend", 0.9);
    feedGate(g1, [1, 2, 3, 4, 5, 6]);
    expect(g1.ratio()).toBeCloseTo(1, 9);
    const g2 = new EfficiencyGate(6, "range", 0.1);
    feedGate(g2, [100, 101, 100, 101, 100, 101, 100]);
    expect(g2.ratio()).toBeCloseTo(0, 9);
  });
  it("mode range : ouvert quand le prix zigzague, fermé en tendance ; mode trend : l'inverse", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(feedGate(new EfficiencyGate(10, "range", 0.2), up).at(-1)).toBe(false);
    expect(feedGate(new EfficiencyGate(10, "trend", 0.5), up).at(-1)).toBe(true);
    expect(feedGate(new EfficiencyGate(10, "range", 0.2), zigzag(20, 0.01)).at(-1)).toBe(true);
    expect(feedGate(new EfficiencyGate(10, "trend", 0.5), zigzag(20, 0.01)).at(-1)).toBe(false);
  });
  it("reste fermé tant que la fenêtre n'est pas remplie, et traite un prix constant comme un range", () => {
    const open = feedGate(new EfficiencyGate(5, "range", 0.1), Array(10).fill(100));
    expect(open.slice(0, 5)).toEqual([false, false, false, false, false]);
    expect(open[5]).toBe(true);
  });
  it("une marche aléatoire a un ratio proche de 1/√fenêtre", () => {
    const g = new EfficiencyGate(48, "range", 0.5);
    const ratios: number[] = [];
    for (const p of syntheticPrices({ n: 20000, seed: 1, vol: 0.01 })) {
      g.update(p);
      const r = g.ratio();
      if (r !== null) ratios.push(r);
    }
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    expect(mean).toBeGreaterThan(0.1);
    expect(mean).toBeLessThan(0.2);
  });
  it("valide ses paramètres", () => {
    expect(() => new EfficiencyGate(3)).toThrow(/gate-window/);
    expect(() => new EfficiencyGate(10, "range", 0)).toThrow(/gate-threshold/);
    expect(() => new EfficiencyGate(10, "range", 1.5)).toThrow(/gate-threshold/);
    expect(() => new EfficiencyGate(10, "x" as any)).toThrow(/mode/);
  });
});

describe("VolatilityGate", () => {
  it("stress : la volatilité récente dépasse nettement la normale", () => {
    const prices = [...zigzag(41, 0.005), ...zigzag(11, 0.03, zigzag(41, 0.005).at(-1))]; // 40 retours à 0,5 % puis 10 à 3 %
    const g = new VolatilityGate(10, "stress", 1.5);
    expect(feedGate(g, prices).at(-1)).toBe(true);
    expect(feedGate(new VolatilityGate(10, "calm", 0.7), prices).at(-1)).toBe(false);
  });
  it("calm : la volatilité récente est bien sous la normale", () => {
    const first = zigzag(41, 0.03);
    const prices = [...first, ...zigzag(11, 0.005, first.at(-1))];
    expect(feedGate(new VolatilityGate(10, "calm", 0.7), prices).at(-1)).toBe(true);
    expect(feedGate(new VolatilityGate(10, "stress", 1.5), prices).at(-1)).toBe(false);
  });
  it("reste fermé tant que l'historique long n'est pas disponible, et si la volatilité est nulle", () => {
    expect(feedGate(new VolatilityGate(10, "stress", 1.5), zigzag(30, 0.03)).some(Boolean)).toBe(false);
    expect(feedGate(new VolatilityGate(10, "calm", 0.7), Array(80).fill(100)).some(Boolean)).toBe(false);
  });
  it("valide ses paramètres", () => {
    expect(() => new VolatilityGate(2)).toThrow(/gate-window/);
    expect(() => new VolatilityGate(10, "stress", 0)).toThrow(/gate-threshold/);
    expect(() => new VolatilityGate(10, "x" as any)).toThrow(/mode/);
  });
});

describe("GatedRule", () => {
  const always = (): EntryRule & { seen: number } => {
    const r = { name: "always", seen: 0, onPrice: (): EntrySignal => { r.seen++; return "long"; } };
    return r;
  };
  it("coupe le signal quand le filtre est fermé, mais la règle et le filtre voient toutes les barres", () => {
    const inner = always();
    const rule = new GatedRule(inner, new EfficiencyGate(5, "range", 0.2));
    const signals = [100, 101, 102, 103, 104, 105, 106, 100, 101, 100, 101, 100, 101, 100].map((p) => rule.onPrice(p));
    expect(inner.seen).toBe(14);
    expect(signals.slice(0, 7).every((s) => s === null)).toBe(true); // tendance ou fenêtre non remplie
    expect(signals.at(-1)).toBe("long"); // zigzag : situation « range »
  });
  it("expose son nom et l'état du filtre", () => {
    const rule = new GatedRule(new DipRule(10, 0.05, "long"), new EfficiencyGate(5, "range", 0.2));
    expect(rule.name).toBe("DIP(10/0.05/long)@range(ER5<=0.2)");
    expect(rule.isOpen()).toBe(false);
  });
  it("le simulateur compte le temps où le filtre était ouvert", () => {
    const cfg: LeverageConfig = { ...DEFAULT_LEVERAGE, policy: "bounded" };
    const p = syntheticPrices({ n: 3000, seed: 3, vol: 0.01 });
    const gated = simulateLeveraged(p, cfg, new GatedRule(new DipRule(24, 0.04, "both"), new EfficiencyGate(48, "range", 0.12)));
    expect(gated.gateOpenBars).toBeGreaterThan(0);
    expect(gated.gateOpenBars).toBeLessThan(gated.eligibleBars);
    const plain = simulateLeveraged(p, cfg, new DipRule(24, 0.04, "both"));
    expect(plain.gateOpenBars).toBe(plain.eligibleBars); // sans filtre : toujours « ouvert »
  });
});

describe("fabrique et noms de filtres", () => {
  it("valide les noms et renvoie undefined pour « none »", () => {
    expect(parseGateName(undefined)).toBe("none");
    expect(() => parseGateName("magic")).toThrow(/--gate/);
    expect(makeGateFactory("none")).toBeUndefined();
    for (const g of ["range", "trend", "calm", "stress"] as const) expect(makeGateFactory(g)!().name).toContain(g);
    expect(makeGateFactory("range", 24, 0.2)!().name).toBe("range(ER24<=0.2)");
  });
});

describe("modèle de marché à phases alternées (mix)", () => {
  it("est déterministe, strictement positif, et diffère des modèles purs", () => {
    const a = syntheticPrices({ n: 3000, seed: 2, model: "mix" });
    expect(a).toEqual(syntheticPrices({ n: 3000, seed: 2, model: "mix" }));
    expect(a.every((p) => p > 0 && Number.isFinite(p))).toBe(true);
    expect(a).not.toEqual(syntheticPrices({ n: 3000, seed: 2, model: "ou" }));
    expect(a).not.toEqual(syntheticPrices({ n: 3000, seed: 2, model: "mom" }));
  });
  it("se situe entre le retour à la moyenne et la tendance pour le ratio d'efficacité moyen", () => {
    const meanEr = (model: "mix" | "gbm" | "ou" | "mom") => {
      const rs: number[] = [];
      for (const seed of [1, 2, 3]) {
        const g = new EfficiencyGate(48, "range", 0.5);
        for (const p of syntheticPrices({ n: 30000, seed, vol: 0.01, model })) {
          g.update(p);
          const r = g.ratio();
          if (r !== null) rs.push(r);
        }
      }
      return rs.reduce((a, b) => a + b, 0) / rs.length;
    };
    const ou = meanEr("ou"); // mesuré : 0,090
    const gbm = meanEr("gbm"); // 0,143 ; théorie 1/√48 = 0,144
    const mom = meanEr("mom"); // 0,189
    const mix = meanEr("mix"); // 0,136
    expect(ou).toBeLessThan(gbm);
    expect(gbm).toBeLessThan(mom);
    expect(mix).toBeGreaterThan(ou + 0.02);
    expect(mix).toBeLessThan(mom - 0.02);
    expect(Math.abs(gbm - 1 / Math.sqrt(48))).toBeLessThan(0.015);
  });
  it("valide segment", () => {
    expect(() => syntheticPrices({ n: 100, seed: 1, model: "mix", segment: 10 })).toThrow(/segment/);
  });
});

describe("avantage conditionnel à une situation (cas témoins)", () => {
  const cfg: LeverageConfig = { ...DEFAULT_LEVERAGE, policy: "bounded", stakeFraction: 0.1, leverage: 5, takeProfitPct: 0.03 };
  const paths = (model: "mix" | "gbm", n: number) => Array.from({ length: n }, (_, i) => syntheticPrices({ n: 4000, seed: i + 1, vol: 0.01, model }));
  const dip = () => new DipRule(24, 0.04, "both");
  const gate = (m: "range" | "trend") => makeGateFactory(m)!;
  const eval_ = (series: number[][], g: "range" | "trend") => evaluateRule(series, cfg, () => new GatedRule(dip(), gate(g)()), "both", 20, gate(g));

  it("dans une situation de tendance, cette règle fait PIRE que le hasard filtré", () => {
    expect(eval_(paths("mix", 30), "trend").meanBeatPct).toBeLessThan(45);
  });
  it("dans la situation « range », la règle fait mieux que des entrées au hasard sans filtre, et la situation seule aide déjà le hasard", () => {
    const e = eval_(paths("mix", 30), "range");
    expect(e.meanBeatNoGatePct!).toBeGreaterThan(60);
    expect(e.rule.medianFinalPct).toBeGreaterThan(e.randomNoGate!.medianFinalPct);
    expect(e.random.medianFinalPct).toBeGreaterThan(e.randomNoGate!.medianFinalPct); // apport de la situation, sans la règle
    expect(e.gateOpenPct).toBeGreaterThan(5);
    expect(e.gateOpenPct).toBeLessThan(60);
  });
  it("le hasard filtré a à peu près autant d'entrées que la règle (comparaison équitable)", () => {
    const e = eval_(paths("mix", 20), "range");
    expect(e.random.medianTrades).toBeGreaterThan(e.rule.medianTrades * 0.5);
    expect(e.random.medianTrades).toBeLessThan(e.rule.medianTrades * 2);
  });
  it("NÉGATIF : sur une marche aléatoire, le filtre ne fait pas apparaître d'avantage", () => {
    const e = eval_(paths("gbm", 40), "range");
    expect(e.meanBeatPct).toBeGreaterThan(30);
    expect(e.meanBeatPct).toBeLessThan(70);
  });
});

describe("entryCommand avec filtre de situation", () => {
  const run = (args: string[]) => {
    const out: string[] = [];
    entryCommand(args, (s) => out.push(s));
    return out.join("\n");
  };
  it("affiche la règle filtrée, le temps d'ouverture et les deux références au hasard", () => {
    const txt = run(["--rule", "dip", "--gate", "range", "--model", "mix", "--seeds", "6", "--n", "2500", "--random", "6", "--policy", "bounded"]);
    expect(txt).toMatch(/DIP\(48\/0\.04\/both\)@range\(ER48<=0\.12\)/);
    expect(txt).toMatch(/hasard filtré\s+hasard libre/);
    expect(txt).toMatch(/Filtre de situation ouvert \d+ % du temps disponible/);
    expect(txt).toMatch(/mieux que \d+ % des entrées au hasard libres/);
  });
  it("sans filtre, l'affichage reste à deux colonnes", () => {
    const txt = run(["--rule", "dip", "--seeds", "4", "--n", "1500", "--random", "6", "--policy", "bounded"]);
    expect(txt).not.toMatch(/hasard libre/);
  });
  it("valide les paramètres du filtre", () => {
    expect(() => run(["--rule", "dip", "--gate", "magic"])).toThrow(/--gate/);
    expect(() => run(["--rule", "dip", "--gate", "range", "--gate-threshold", "9"])).toThrow(/gate-threshold/);
    expect(() => run(["--rule", "dip", "--gate", "range", "--gate-window", "2"])).toThrow(/gate-window/);
  });
});
