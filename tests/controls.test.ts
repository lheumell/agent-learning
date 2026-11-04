import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backtestCommand } from "../src/backtest-cli.js";
import { holdoutCommand } from "../src/holdout-cli.js";
import { HOLDOUT_MIN_BARS, recordLook, splitHoldout } from "../src/holdout.js";
import { syntheticPrices } from "../src/simulate.js";
import { ZScoreReversion } from "../src/strategy.js";
import { FEE_LEVELS, walkforwardCommand } from "../src/walkforward-cli.js";
import { ZREV_FIXED, ZREV_GRID, ZREV_SPEC, evaluateSegment, walkForward } from "../src/walkforward.js";

const zrevCfg = { trainBars: 500, testBars: 250, grid: ZREV_GRID, fixed: ZREV_FIXED, spec: ZREV_SPEC };
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const tmp = () => mkdtempSync(join(tmpdir(), "ctl-"));
const csvOf = (prices: number[]) => "close\n" + prices.join("\n") + "\n";

describe("ZScoreReversion", () => {
  it("achète sous -entryZ puis vend en remontant", () => {
    const s = new ZScoreReversion(5, 1.5, 0);
    expect([10, 10, 10, 10, 10, 6, 10].map((p) => s.onPrice(p))).toEqual(
      ["hold", "hold", "hold", "hold", "hold", "buy", "sell"],
    );
  });
  it("reste muet sur une série plate (écart-type nul)", () => {
    const s = new ZScoreReversion(5, 1, 0);
    expect(Array(20).fill(100).every((p) => s.onPrice(p) === "hold")).toBe(true);
  });
  it("ne dépend que des `window` derniers prix (pas d'état caché, reprise du mode papier fiable)", () => {
    const tail = [101, 99, 100, 98, 97, 96, 95, 99, 94, 90];
    const a = new ZScoreReversion(10, 1.5, 0);
    const b = new ZScoreReversion(10, 1.5, 0);
    [50, 200, 7, 123, 80, 60, 300, ...tail].forEach((p) => a.onPrice(p));
    [1, 2, 3, ...tail].forEach((p) => b.onPrice(p));
    expect(a.onPrice(88)).toBe(b.onPrice(88));
  });
  it("valide les paramètres et les prix", () => {
    expect(() => new ZScoreReversion(3)).toThrow(/window/);
    expect(() => new ZScoreReversion(10, 0)).toThrow(/entryZ/);
    expect(() => new ZScoreReversion(10, 1, -1)).toThrow(/exitZ/);
    expect(() => new ZScoreReversion(10).onPrice(-1)).toThrow(/invalide/);
  });
});

describe("modèle Ornstein-Uhlenbeck", () => {
  const range = (xs: number[]) => Math.max(...xs.map(Math.log)) - Math.min(...xs.map(Math.log));
  it("est déterministe et strictement positif", () => {
    const a = syntheticPrices({ n: 500, seed: 3, model: "ou" });
    expect(a).toEqual(syntheticPrices({ n: 500, seed: 3, model: "ou" }));
    expect(a.every((p) => p > 0 && Number.isFinite(p))).toBe(true);
  });
  it("reste proche de sa moyenne alors qu'une marche aléatoire s'éloigne", () => {
    const ou = [1, 2, 3, 4, 5].map((seed) => range(syntheticPrices({ n: 5000, seed, model: "ou" })));
    const gbm = [1, 2, 3, 4, 5].map((seed) => range(syntheticPrices({ n: 5000, seed })));
    expect(Math.max(...ou)).toBeLessThan(0.45);
    expect(gbm.reduce((a, b) => a + b) / 5).toBeGreaterThan(0.6);
  });
  it("valide model et theta", () => {
    expect(() => syntheticPrices({ n: 10, seed: 1, model: "x" as any })).toThrow(/modèle inconnu/);
    expect(() => syntheticPrices({ n: 10, seed: 1, model: "ou", theta: 0 })).toThrow(/theta/);
  });
});

describe("cas témoins du walk-forward", () => {
  it("POSITIF : détecte un vrai avantage (retour à la moyenne) hors échantillon", () => {
    const rs = Array.from({ length: 40 }, (_, i) => walkForward(syntheticPrices({ n: 2000, seed: 200 + i, model: "ou" }), zrevCfg));
    expect(med(rs.map((r) => r.meanOosPer100))).toBeGreaterThan(1);
    expect(med(rs.map((r) => r.oosCompoundedPct))).toBeGreaterThan(20);
    expect(rs.filter((r) => r.oosCompoundedPct > 0).length / rs.length).toBeGreaterThan(0.85);
  });
  it("NÉGATIF : sur une marche aléatoire, l'avantage apparent à l'entraînement disparaît en test", () => {
    const rs = Array.from({ length: 40 }, (_, i) => walkForward(syntheticPrices({ n: 2000, seed: 300 + i }), zrevCfg));
    const is = med(rs.map((r) => r.meanIsPer100));
    const oos = med(rs.map((r) => r.meanOosPer100));
    expect(is).toBeGreaterThan(0);
    expect(oos).toBeLessThan(is - 1);
    expect(rs.filter((r) => r.oosCompoundedPct > 0).length / rs.length).toBeLessThan(0.5);
  });
});

describe("walk-forward générique", () => {
  const prices = syntheticPrices({ n: 2000, seed: 5, model: "ou" });
  it("ne fuit pas le futur avec une autre stratégie", () => {
    const base = walkForward(prices, zrevCfg);
    const f = base.folds[2];
    const tampered = prices.map((p, i) => (i >= f.testStart ? p * (1 + 0.4 * Math.sin(i)) : p));
    const alt = walkForward(tampered, zrevCfg).folds[2];
    expect(alt.params).toEqual(f.params);
    expect(alt.isReturnPct).toBe(f.isReturnPct);
    expect(alt.oosReturnPct).not.toBe(f.oosReturnPct);
  });
  it("exige des paramètres fixes avec une stratégie personnalisée", () => {
    expect(() => walkForward(prices, { trainBars: 500, testBars: 250, grid: ZREV_GRID, spec: ZREV_SPEC })).toThrow(/fixed est obligatoire/);
  });
  it("evaluateSegment échauffe avec le passé et compare à acheter-garder sur la fenêtre", () => {
    const r = evaluateSegment(prices, 1000, 1500, () => new ZScoreReversion(50, 2, 0), 50);
    expect(r.buyHoldPct).toBeCloseTo((prices[1499] / prices[1000] - 1) * 100, 0);
    expect(r.trades).toBeGreaterThan(0);
  });
});

describe("sensibilité aux frais", () => {
  it("le rendement à paramètres fixes baisse strictement quand les frais montent", () => {
    const prices = syntheticPrices({ n: 2000, seed: 8, model: "ou" });
    const rets = FEE_LEVELS.map((fee) =>
      walkForward(prices, { ...zrevCfg, exec: { feeRate: fee, slippageRate: 0.0005 } }).fixedCompoundedPct,
    );
    for (let i = 1; i < rets.length; i++) expect(rets[i]).toBeLessThan(rets[i - 1]);
  });
  it("--fee-sweep affiche un tableau par niveau de frais", () => {
    const out: string[] = [];
    walkforwardCommand(["--fee-sweep", "--seeds", "3", "--strategy", "zrev", "--model", "ou"], (s) => out.push(s));
    const txt = out.join("\n");
    expect(txt).toMatch(/Sensibilité aux frais/);
    expect((txt.match(/ %\s+[+-]\d/g) ?? []).length).toBeGreaterThanOrEqual(FEE_LEVELS.length);
  });
});

describe("période réservée (holdout)", () => {
  it("coupe la fin de la série sans recouvrement", () => {
    const p = Array.from({ length: 1000 }, (_, i) => i + 1);
    const { dev, holdout, cut } = splitHoldout(p, 0.2);
    expect(dev).toHaveLength(800);
    expect(holdout).toHaveLength(200);
    expect(cut).toBe(800);
    expect(dev.at(-1)! + 1).toBe(holdout[0]);
  });
  it("refuse des parts ou des périodes absurdes", () => {
    const p = Array(1000).fill(1);
    expect(() => splitHoldout(p, 0.01)).toThrow(/entre 0.05 et 0.5/);
    expect(() => splitHoldout(p, 0.9)).toThrow(/entre 0.05 et 0.5/);
    expect(() => splitHoldout(Array(300).fill(1), 0.2)).toThrow(new RegExp(`minimum ${HOLDOUT_MIN_BARS}`));
  });
  it("compte les regards de façon persistante, par fichier", () => {
    const log = join(tmp(), "log.json");
    expect(recordLook(log, "a.csv@0.2")).toBe(1);
    expect(recordLook(log, "a.csv@0.2")).toBe(2);
    expect(recordLook(log, "b.csv@0.2")).toBe(1);
  });
  it("refuse un journal corrompu au lieu de l'écraser", () => {
    const log = join(tmp(), "log.json");
    writeFileSync(log, "{pas du json");
    expect(() => recordLook(log, "x")).toThrow(/illisible/);
  });

  const prices = syntheticPrices({ n: 2000, seed: 21, model: "ou" });
  const setup = () => {
    const dir = tmp();
    const csv = join(dir, "p.csv");
    writeFileSync(csv, csvOf(prices));
    return { csv, logPath: join(dir, "log.json") };
  };

  it("le walk-forward --holdout n'utilise que la partie développement", () => {
    const { csv } = setup();
    const out: string[] = [];
    walkforwardCommand(["--csv", csv, "--holdout", "0.2", "--strategy", "zrev"], (s) => out.push(s));
    const txt = out.join("\n");
    const dev = prices.slice(0, 1600);
    const folds = walkForward(dev, zrevCfg).folds.length;
    expect(txt).toMatch(new RegExp(`positives : \\d+/${folds}\\b`));
    expect(txt).toMatch(/Période réservée : 400 barres \(20 %\)/);
  });
  it("npm run holdout évalue la fin, une seule stratégie, et compte les regards", () => {
    const { csv, logPath } = setup();
    const run = () => {
      const out: string[] = [];
      holdoutCommand(["--csv", csv, "--strategy", "zrev"], (s) => out.push(s), { logPath });
      return out.join("\n");
    };
    const first = run();
    expect(first).toMatch(/400 barres/);
    expect(first).toMatch(/1er regard/);
    const manual = evaluateSegment(prices, 1600, 2000, () => new ZScoreReversion(50, 2, 0), 50, { feeRate: 0.001, slippageRate: 0.0005 });
    expect(first).toContain(`${manual.returnPct >= 0 ? "+" : ""}${manual.returnPct.toFixed(2)} %`);
    expect(run()).toMatch(/2e regard.*n'est plus indépendante/s);
  });
  it("exige --csv", () => {
    expect(() => holdoutCommand([], () => {})).toThrow(/--csv/);
  });
});

describe("choix de la stratégie en ligne de commande", () => {
  const run = (args: string[]) => {
    const out: string[] = [];
    backtestCommand(args, (s) => out.push(s));
    return out.join("\n");
  };
  it("backtest --strategy zrev sur un marché qui revient à la moyenne", () => {
    expect(run(["--strategy", "zrev", "--model", "ou", "--seeds", "5"])).toMatch(/ZREV\(50\/2\/0\)/);
  });
  it("rejette une stratégie ou un modèle inconnus", () => {
    expect(() => run(["--strategy", "magic"])).toThrow(/stratégie inconnue/);
    expect(() => run(["--model", "x"])).toThrow(/--model/);
    const out: string[] = [];
    expect(() => walkforwardCommand(["--strategy", "magic"], (s) => out.push(s))).toThrow(/stratégie inconnue/);
  });
});
