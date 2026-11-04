import { readFileSync } from "node:fs";

/** PRNG déterministe (mulberry32) : même graine, même série. Indispensable pour reproduire un résultat. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticOptions {
  n: number;
  seed: number;
  start?: number;
  /** Dérive moyenne par barre (ex. 0.0002). 0 = marche aléatoire pure. */
  drift?: number;
  /** Volatilité par barre (ex. 0.01 = 1 %). */
  vol?: number;
  /**
   * "gbm" : marche aléatoire (aucun avantage possible, cas témoin négatif).
   * "ou"  : Ornstein-Uhlenbeck sur le log-prix, le prix est rappelé vers `start` (cas témoin positif :
   *         un avantage réel EXISTE, un bon test doit le détecter). `drift` est ignoré dans ce modèle.
   */
  model?: "gbm" | "ou";
  /** Force de rappel par barre pour "ou" (0.05 = demi-vie d'environ 14 barres). */
  theta?: number;
}

/** Mouvement brownien géométrique : les prix restent strictement positifs. */
export function syntheticPrices(o: SyntheticOptions): number[] {
  const { n, seed, start = 100, drift = 0, vol = 0.01, model = "gbm", theta = 0.05 } = o;
  if (!Number.isInteger(n) || n < 2) throw new Error("n doit être un entier >= 2");
  if (model !== "gbm" && model !== "ou") throw new Error(`modèle inconnu : ${model} (gbm | ou)`);
  if (!(theta > 0 && theta <= 1)) throw new Error("theta doit être dans ]0, 1]");
  const rnd = mulberry32(seed);
  const normal = () => {
    const u = Math.max(rnd(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  if (model === "ou") {
    const mu = Math.log(start);
    let x = mu;
    const out = [start];
    for (let i = 1; i < n; i++) {
      x = x + theta * (mu - x) + vol * normal();
      out.push(Math.exp(x));
    }
    return out;
  }
  const out = [start];
  for (let i = 1; i < n; i++) {
    out.push(out[i - 1] * Math.exp(drift - (vol * vol) / 2 + vol * normal()));
  }
  return out;
}

/** Lit un CSV : colonne « close » si l'en-tête existe, sinon la dernière colonne. Ignore les lignes non numériques. */
export function parseCsvPrices(text: string): number[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("CSV vide");
  const sep = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const closeIdx = header.indexOf("close");
  const prices: number[] = [];
  for (const line of lines) {
    const cols = line.split(sep);
    const raw = closeIdx >= 0 ? cols[closeIdx] : cols[cols.length - 1];
    const v = Number(raw);
    if (raw !== undefined && raw.trim() !== "" && Number.isFinite(v)) prices.push(v);
  }
  if (prices.length < 2) throw new Error("moins de 2 prix numériques dans le CSV");
  return prices;
}

export const loadCsvPrices = (path: string) => parseCsvPrices(readFileSync(path, "utf8"));
