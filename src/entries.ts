import type { EntryRule, EntrySignal } from "./leverage.js";
import { mulberry32 } from "./simulate.js";

export type Sides = "long" | "both";

function checkLookback(n: number) {
  if (!Number.isInteger(n) || n < 2) throw new Error(`lookback invalide : ${n} (entier >= 2)`);
}
function checkSides(s: string) {
  if (s !== "long" && s !== "both") throw new Error(`sides invalide : "${s}" (long | both)`);
}

/**
 * « J'achète après une baisse » (retour à la moyenne).
 * - long quand le prix est au moins `dropPct` sous le plus haut des `lookback` barres précédentes ;
 * - si sides = both, short quand il est au moins `dropPct` au-dessus du plus bas des `lookback` barres précédentes.
 * Si les deux conditions se vérifient en même temps (marché très agité), aucun signal.
 */
export class DipRule implements EntryRule {
  readonly name: string;
  private buf: number[] = [];
  constructor(private lookback = 48, private dropPct = 0.04, private sides: Sides = "both") {
    checkLookback(lookback);
    checkSides(sides);
    if (!(dropPct > 0 && dropPct < 1)) throw new Error(`dropPct invalide : ${dropPct} (]0, 1[)`);
    this.name = `DIP(${lookback}/${dropPct}/${sides})`;
  }
  onPrice(p: number): EntrySignal {
    let signal: EntrySignal = null;
    if (this.buf.length >= this.lookback) {
      const hi = Math.max(...this.buf);
      const lo = Math.min(...this.buf);
      const dip = p <= hi * (1 - this.dropPct);
      const pump = this.sides === "both" && p >= lo * (1 + this.dropPct);
      if (dip && !pump) signal = "long";
      else if (pump && !dip) signal = "short";
    }
    this.buf.push(p);
    if (this.buf.length > this.lookback) this.buf.shift();
    return signal;
  }
}

/**
 * « Je suis la cassure d'un niveau » (tendance).
 * - long quand le prix dépasse le plus haut des `lookback` barres précédentes ;
 * - si sides = both, short quand il passe sous le plus bas des `lookback` barres précédentes.
 */
export class BreakoutRule implements EntryRule {
  readonly name: string;
  private buf: number[] = [];
  constructor(private lookback = 48, private sides: Sides = "both") {
    checkLookback(lookback);
    checkSides(sides);
    this.name = `BREAKOUT(${lookback}/${sides})`;
  }
  onPrice(p: number): EntrySignal {
    let signal: EntrySignal = null;
    if (this.buf.length >= this.lookback) {
      if (p > Math.max(...this.buf)) signal = "long";
      else if (this.sides === "both" && p < Math.min(...this.buf)) signal = "short";
    }
    this.buf.push(p);
    if (this.buf.length > this.lookback) this.buf.shift();
    return signal;
  }
}

/**
 * Référence : des entrées au hasard, à la même fréquence qu'une règle. Si une règle ne fait pas mieux que ça
 * avec les mêmes sorties, elle n'a pas d'avantage d'entrée.
 */
export class RandomRule implements EntryRule {
  readonly name: string;
  private rnd: () => number;
  constructor(private prob: number, seed: number, private sides: Sides = "both") {
    if (!(prob >= 0 && prob <= 1)) throw new Error(`prob invalide : ${prob} ([0, 1])`);
    checkSides(sides);
    this.rnd = mulberry32(seed);
    this.name = `RANDOM(${prob.toFixed(4)}/${sides})`;
  }
  onPrice(): EntrySignal {
    if (this.rnd() >= this.prob) return null;
    if (this.sides === "long") return "long";
    return this.rnd() < 0.5 ? "long" : "short";
  }
}
