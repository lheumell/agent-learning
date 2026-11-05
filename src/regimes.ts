import type { EntryRule, EntrySignal } from "./leverage.js";

/**
 * Un FILTRE DE SITUATION décide, à chaque barre et avec le seul passé, si l'on est dans la situation visée.
 * Il est défini par une condition chiffrée, fixée AVANT de regarder les résultats.
 */
export interface Gate {
  readonly name: string;
  update(price: number): void;
  isOpen(): boolean;
}

export type EfficiencyMode = "range" | "trend";
export type VolMode = "calm" | "stress";

/**
 * Ratio d'efficacité de Kaufman sur `window` barres : |variation nette| / somme des |variations|.
 * Proche de 0 : le prix zigzague sans aller nulle part (marché sans tendance, « range »).
 * Proche de 1 : le prix avance en ligne droite (tendance). Une marche aléatoire donne environ 1/√window.
 */
export class EfficiencyGate implements Gate {
  readonly name: string;
  private buf: number[] = [];
  constructor(private window = 48, private mode: EfficiencyMode = "range", private threshold = 0.12) {
    if (!Number.isInteger(window) || window < 5) throw new Error(`gate-window invalide : ${window} (entier >= 5)`);
    if (mode !== "range" && mode !== "trend") throw new Error(`mode invalide : ${mode}`);
    if (!(threshold > 0 && threshold <= 1)) throw new Error(`gate-threshold invalide : ${threshold} (]0, 1])`);
    this.name = `${mode}(ER${window}${mode === "range" ? "<=" : ">="}${threshold})`;
  }
  update(p: number) {
    this.buf.push(p);
    if (this.buf.length > this.window + 1) this.buf.shift();
  }
  ratio(): number | null {
    if (this.buf.length < this.window + 1) return null;
    let path = 0;
    for (let i = 1; i < this.buf.length; i++) path += Math.abs(this.buf[i] - this.buf[i - 1]);
    return path === 0 ? 0 : Math.abs(this.buf[this.buf.length - 1] - this.buf[0]) / path;
  }
  isOpen(): boolean {
    const r = this.ratio();
    if (r === null) return false;
    return this.mode === "range" ? r <= this.threshold : r >= this.threshold;
  }
}

/**
 * Rapport de volatilité : écart-type des rendements sur `window` barres / sur 5 x `window` barres.
 * > 1 : la volatilité récente dépasse la normale (stress, panique) ; < 1 : marché calme.
 */
export class VolatilityGate implements Gate {
  readonly name: string;
  private buf: number[] = [];
  constructor(private window = 24, private mode: VolMode = "stress", private threshold = 1.5) {
    if (!Number.isInteger(window) || window < 5) throw new Error(`gate-window invalide : ${window} (entier >= 5)`);
    if (mode !== "calm" && mode !== "stress") throw new Error(`mode invalide : ${mode}`);
    if (!(threshold > 0)) throw new Error(`gate-threshold invalide : ${threshold} (> 0)`);
    this.name = `${mode}(VOL${window}${mode === "stress" ? ">=" : "<="}${threshold}x)`;
  }
  update(p: number) {
    this.buf.push(p);
    if (this.buf.length > 5 * this.window + 1) this.buf.shift();
  }
  private sd(prices: number[]): number {
    const r = prices.slice(1).map((x, i) => Math.log(x / prices[i]));
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
  }
  ratio(): number | null {
    if (this.buf.length < 5 * this.window + 1) return null;
    const long = this.sd(this.buf);
    if (long === 0) return null;
    return this.sd(this.buf.slice(-this.window - 1)) / long;
  }
  isOpen(): boolean {
    const r = this.ratio();
    if (r === null) return false;
    return this.mode === "stress" ? r >= this.threshold : r <= this.threshold;
  }
}

/**
 * Une règle d'entrée qui n'agit que dans la situation visée. La règle et le filtre voient TOUTES les barres
 * (pour tenir leur état à jour) ; le signal n'est retransmis que si le filtre est ouvert.
 */
export class GatedRule implements EntryRule {
  readonly name: string;
  constructor(private inner: EntryRule, private gate: Gate) {
    this.name = `${inner.name}@${gate.name}`;
  }
  onPrice(p: number): EntrySignal {
    this.gate.update(p);
    const s = this.inner.onPrice(p);
    return this.gate.isOpen() ? s : null;
  }
  isOpen(): boolean {
    return this.gate.isOpen();
  }
}

export const GATE_NAMES = ["none", "range", "trend", "calm", "stress"] as const;
export type GateName = (typeof GATE_NAMES)[number];

export function parseGateName(raw: string | undefined): GateName {
  const g = raw ?? "none";
  if (!(GATE_NAMES as readonly string[]).includes(g)) throw new Error(`--gate : ${GATE_NAMES.join(" | ")} (reçu "${g}")`);
  return g as GateName;
}

/** Fabrique de filtre, avec des valeurs par défaut raisonnables mais NON optimisées. */
export function makeGateFactory(name: GateName, window?: number, threshold?: number): (() => Gate) | undefined {
  switch (name) {
    case "none":
      return undefined;
    case "range":
      return () => new EfficiencyGate(window ?? 48, "range", threshold ?? 0.12);
    case "trend":
      return () => new EfficiencyGate(window ?? 48, "trend", threshold ?? 0.3);
    case "calm":
      return () => new VolatilityGate(window ?? 24, "calm", threshold ?? 0.7);
    case "stress":
      return () => new VolatilityGate(window ?? 24, "stress", threshold ?? 1.5);
  }
}
