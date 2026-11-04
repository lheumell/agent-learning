import { describe, expect, it } from "vitest";
import { backtestCommand } from "../src/backtest-cli.js";
import { parseCsvPrices, syntheticPrices } from "../src/simulate.js";

describe("syntheticPrices", () => {
  it("est déterministe pour une graine donnée", () => {
    expect(syntheticPrices({ n: 50, seed: 7 })).toEqual(syntheticPrices({ n: 50, seed: 7 }));
  });
  it("change avec la graine", () => {
    expect(syntheticPrices({ n: 50, seed: 1 })).not.toEqual(syntheticPrices({ n: 50, seed: 2 }));
  });
  it("reste strictement positif et de la bonne longueur", () => {
    const p = syntheticPrices({ n: 5000, seed: 3, vol: 0.05 });
    expect(p).toHaveLength(5000);
    expect(p.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
  });
  it("refuse n invalide", () => {
    expect(() => syntheticPrices({ n: 1, seed: 1 })).toThrow(/n doit/);
  });
});

describe("parseCsvPrices", () => {
  it("utilise la colonne close de l'en-tête", () => {
    expect(parseCsvPrices("date,open,close\n2026-01-01,1,10\n2026-01-02,2,20\n")).toEqual([10, 20]);
  });
  it("sans en-tête, prend la dernière colonne", () => {
    expect(parseCsvPrices("1,5\n2,6\n3,7")).toEqual([5, 6, 7]);
  });
  it("accepte le point-virgule et ignore les lignes invalides", () => {
    expect(parseCsvPrices("t;close\na;1.5\nb;n/a\nc;2.5")).toEqual([1.5, 2.5]);
  });
  it("refuse un CSV vide ou trop court", () => {
    expect(() => parseCsvPrices("")).toThrow(/vide/);
    expect(() => parseCsvPrices("close\n5")).toThrow(/moins de 2/);
  });
});

describe("backtestCommand", () => {
  const run = (args: string[]) => {
    const out: string[] = [];
    backtestCommand(args, (s) => out.push(s));
    return out.join("\n");
  };
  it("agrège plusieurs séries", () => {
    const txt = run(["--seeds", "5", "--n", "200"]);
    expect(txt).toMatch(/5 séries simulées/);
    expect(txt).toMatch(/bat acheter-garder/);
  });
  it("affiche l'aide", () => expect(run(["--help"])).toMatch(/Usage/));
  it("rejette les arguments mal formés", () => {
    expect(() => run(["--fast"])).toThrow(/attend une valeur/);
    expect(() => run(["oops"])).toThrow(/inattendu/);
    expect(() => run(["--fast", "abc"])).toThrow(/nombre/);
  });
  it("rejette des fenêtres incohérentes", () => {
    expect(() => run(["--fast", "30", "--slow", "10"])).toThrow(/invalides/);
  });
});
