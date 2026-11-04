import { SmaCrossover, ZScoreReversion, type Strategy } from "./strategy.js";
import {
  DEFAULT_FIXED,
  DEFAULT_GRID,
  SMA_SPEC,
  ZREV_FIXED,
  ZREV_GRID,
  ZREV_SPEC,
  type StrategySpec,
} from "./walkforward.js";

export const STRATEGY_NAMES = ["sma", "zrev"] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export function parseStrategyName(raw: string | undefined): StrategyName {
  const n = raw ?? "sma";
  if (!(STRATEGY_NAMES as readonly string[]).includes(n)) {
    throw new Error(`stratégie inconnue : "${n}" (${STRATEGY_NAMES.join(" | ")})`);
  }
  return n as StrategyName;
}

/** Stratégie à paramètres fixes, lue sur la ligne de commande. */
export function strategyFromFlags(
  name: StrategyName,
  num: (key: string, def: number) => number,
): { make: () => Strategy; warmup: number } {
  if (name === "zrev") {
    const window = num("window", ZREV_FIXED.window);
    const entry = num("entry", ZREV_FIXED.entryZ);
    const exit = num("exit", ZREV_FIXED.exitZ);
    return { make: () => new ZScoreReversion(window, entry, exit), warmup: window };
  }
  const fast = num("fast", DEFAULT_FIXED.fast);
  const slow = num("slow", DEFAULT_FIXED.slow);
  return { make: () => new SmaCrossover(fast, slow), warmup: slow };
}

/** Famille + grille + paramètres fixes de référence pour le walk-forward. */
export function walkForwardSetup(name: StrategyName): { spec: StrategySpec<any>; grid: any[]; fixed: any } {
  return name === "zrev"
    ? { spec: ZREV_SPEC, grid: ZREV_GRID, fixed: ZREV_FIXED }
    : { spec: SMA_SPEC, grid: DEFAULT_GRID, fixed: DEFAULT_FIXED };
}
