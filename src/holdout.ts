import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const HOLDOUT_MIN_BARS = 100;

/**
 * Sépare la FIN de la série : `dev` sert à tout (choix, essais, walk-forward) ;
 * `holdout` n'est regardé qu'à la toute fin, une seule fois.
 */
export function splitHoldout(prices: number[], pct: number): { dev: number[]; holdout: number[]; cut: number } {
  if (!(pct >= 0.05 && pct <= 0.5)) throw new Error("--holdout doit être entre 0.05 et 0.5 (part de la série mise de côté)");
  const cut = Math.floor(prices.length * (1 - pct));
  const holdout = prices.slice(cut);
  if (holdout.length < HOLDOUT_MIN_BARS) {
    throw new Error(`période réservée trop courte : ${holdout.length} barres (minimum ${HOLDOUT_MIN_BARS})`);
  }
  return { dev: prices.slice(0, cut), holdout, cut };
}

/**
 * Compte combien de fois on a regardé la période réservée pour un fichier donné.
 * Chaque regard supplémentaire la contamine : si l'on ajuste ses choix après l'avoir vue,
 * elle devient une donnée d'entraînement de plus.
 */
export function recordLook(logPath: string, key: string): number {
  let log: Record<string, number> = {};
  if (existsSync(logPath)) {
    try {
      log = JSON.parse(readFileSync(logPath, "utf8"));
    } catch {
      throw new Error(`journal illisible : ${logPath} (supprimez-le s'il est corrompu)`);
    }
  }
  log[key] = (log[key] ?? 0) + 1;
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, JSON.stringify(log, null, 2));
  return log[key];
}
