import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest.js";
import { syntheticPrices } from "../src/simulate.js";
import { SmaCrossover } from "../src/strategy.js";
import { DEFAULT_GRID, per100, walkForward, type WalkForwardConfig } from "../src/walkforward.js";
import { walkforwardCommand } from "../src/walkforward-cli.js";

const prices = syntheticPrices({ n: 2000, seed: 5 });
const cfg: WalkForwardConfig = { trainBars: 500, testBars: 250, grid: DEFAULT_GRID };

describe("walkForward : structure des fenêtres", () => {
  const r = walkForward(prices, cfg);
  it("découpe 2000 barres en 6 fenêtres 500/250 contiguës", () => {
    expect(r.folds).toHaveLength(6);
    r.folds.forEach((f, k) => {
      expect(f.trainStart).toBe(250 * k);
      expect(f.testStart).toBe(250 * k + 500);
      expect(f.testEnd).toBe(f.testStart + 250);
    });
    expect(r.folds.at(-1)!.testEnd).toBe(2000);
  });
  it("les fenêtres de test ne se recouvrent pas", () => {
    for (let k = 1; k < r.folds.length; k++) expect(r.folds[k].testStart).toBe(r.folds[k - 1].testEnd);
  });
  it("un pas plus petit donne plus de fenêtres", () => {
    expect(walkForward(prices, { ...cfg, stepBars: 125 }).folds.length).toBeGreaterThan(r.folds.length);
  });
  it("est déterministe", () => {
    expect(walkForward(prices, cfg)).toEqual(r);
  });
});

describe("walkForward : pas de fuite du futur", () => {
  it("modifier les prix à partir du début du test ne change ni les paramètres ni le rendement d'entraînement", () => {
    const base = walkForward(prices, cfg);
    for (const k of [0, 3]) {
      const f = base.folds[k];
      const tampered = prices.map((p, i) => (i >= f.testStart ? p * (1 + 0.5 * Math.sin(i)) : p));
      const alt = walkForward(tampered, cfg).folds[k];
      expect(alt.params).toEqual(f.params);
      expect(alt.isReturnPct).toBe(f.isReturnPct);
      expect(alt.oosReturnPct).not.toBe(f.oosReturnPct); // et le test, lui, réagit bien
    }
  });
  it("le rendement de test correspond à un backtest manuel avec échauffement avant la fenêtre", () => {
    const f = walkForward(prices, cfg).folds[2];
    const start = f.testStart - f.params.slow;
    const manual = runBacktest(prices.slice(start, f.testEnd), new SmaCrossover(f.params.fast, f.params.slow));
    expect(f.oosReturnPct).toBeCloseTo(manual.returnPct, 9);
    expect(f.oosTrades).toBe(manual.trades.length);
  });
});

describe("walkForward : agrégats", () => {
  it("compose les rendements de test", () => {
    const r = walkForward(prices, cfg);
    const manual = (r.folds.reduce((a, f) => a * (1 + f.oosReturnPct / 100), 1) - 1) * 100;
    expect(r.oosCompoundedPct).toBeCloseTo(manual, 9);
  });
  it("compte les fenêtres positives", () => {
    const r = walkForward(prices, cfg);
    expect(r.positiveFolds).toBe(r.folds.filter((f) => f.oosReturnPct > 0).length);
  });
  it("avec une grille réduite aux paramètres fixes, optimisé = fixe", () => {
    const r = walkForward(prices, { ...cfg, grid: [{ fast: 10, slow: 30 }] });
    r.folds.forEach((f) => expect(f.oosReturnPct).toBeCloseTo(f.fixedOosReturnPct, 12));
  });
  it("série plate : aucun trade, rendement nul, premier jeu de la grille", () => {
    const flat = Array(1000).fill(100);
    const r = walkForward(flat, cfg);
    expect(r.folds.every((f) => f.oosReturnPct === 0 && f.oosTrades === 0)).toBe(true);
    expect(r.folds[0].params).toEqual(DEFAULT_GRID[0]);
  });
});

describe("walkForward : validation", () => {
  it("refuse les configurations incohérentes", () => {
    expect(() => walkForward(prices, { ...cfg, grid: [] })).toThrow(/vide/);
    expect(() => walkForward(prices, { ...cfg, trainBars: 100 })).toThrow(/trainBars trop court/);
    expect(() => walkForward(prices, { ...cfg, testBars: 10 })).toThrow(/testBars trop court/);
    expect(() => walkForward(prices.slice(0, 600), cfg)).toThrow(/trop courte/);
    expect(() => walkForward(prices, { ...cfg, stepBars: 0 })).toThrow(/stepBars/);
  });
});

describe("per100", () => {
  it("normalise par longueur de fenêtre", () => {
    expect(per100(10, 100)).toBeCloseTo(10, 9);
    expect(per100(0, 123)).toBe(0);
    expect(per100(21, 50)).toBeCloseTo(46.41, 2); // 1,21² − 1
  });
});

describe("le phénomène que ce test est censé révéler", () => {
  it("sur une marche aléatoire, les paramètres optimisés paraissent meilleurs à l'entraînement qu'en test", () => {
    const rs = Array.from({ length: 60 }, (_, i) =>
      walkForward(syntheticPrices({ n: 2000, seed: 100 + i }), cfg),
    );
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const is = med(rs.map((r) => r.meanIsPer100));
    const oos = med(rs.map((r) => r.meanOosPer100));
    expect(is).toBeGreaterThan(0); // biais de sélection : on prend le meilleur de 35 jeux
    expect(oos).toBeLessThan(is - 1); // …qui ne se retrouve pas sur des données neuves
  });
});

describe("walkforwardCommand", () => {
  const run = (args: string[]) => {
    const out: string[] = [];
    walkforwardCommand(args, (s) => out.push(s));
    return out.join("\n");
  };
  it("affiche le tableau pour une série", () => {
    const txt = run([]);
    expect(txt).toMatch(/Walk-forward \(entraînement 500 \/ test 250\)/);
    expect(txt).toMatch(/Fenêtres de test positives/);
  });
  it("agrège plusieurs séries", () => {
    const txt = run(["--seeds", "5"]);
    expect(txt).toMatch(/5 séries simulées/);
    expect(txt).toMatch(/jamais vues/);
  });
  it("affiche l'aide et rejette les mauvais arguments", () => {
    expect(run(["--help"])).toMatch(/Usage/);
    expect(() => run(["--train"])).toThrow(/attend une valeur/);
    expect(() => run(["--train", "50"])).toThrow(/trop court/);
    expect(() => run(["--n", "500"])).toThrow(/trop courte/);
  });
});
