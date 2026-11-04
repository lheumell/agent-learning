import { describe, expect, it } from "vitest";
import { SmaCrossover } from "../src/strategy.js";

describe("SmaCrossover", () => {
  it("détecte un croisement haussier puis baissier", () => {
    const s = new SmaCrossover(2, 3);
    const out = [10, 10, 10, 20, 20, 5].map((p) => s.onPrice(p));
    expect(out).toEqual(["hold", "hold", "hold", "buy", "hold", "sell"]);
  });
  it("reste muet tant que la fenêtre lente n'est pas remplie", () => {
    const s = new SmaCrossover(2, 5);
    expect([1, 2, 3, 4].map((p) => s.onPrice(p))).toEqual(["hold", "hold", "hold", "hold"]);
  });
  it("ne déclenche rien sur une série plate", () => {
    const s = new SmaCrossover(2, 3);
    expect(Array(10).fill(100).map((p) => s.onPrice(p)).every((x) => x === "hold")).toBe(true);
  });
  it("refuse des fenêtres invalides", () => {
    expect(() => new SmaCrossover(5, 5)).toThrow(/invalides/);
    expect(() => new SmaCrossover(0, 5)).toThrow(/invalides/);
    expect(() => new SmaCrossover(2.5, 5)).toThrow(/invalides/);
  });
  it("refuse un prix invalide", () => {
    const s = new SmaCrossover(2, 3);
    expect(() => s.onPrice(NaN)).toThrow(/invalide/);
    expect(() => s.onPrice(-1)).toThrow(/invalide/);
  });
});
