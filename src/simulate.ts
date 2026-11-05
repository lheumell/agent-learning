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
  model?: "gbm" | "ou" | "mom" | "mix";
  /** Force de rappel par barre pour "ou" (0.05 = demi-vie d'environ 14 barres). */
  theta?: number;
  /**
   * "mom" : la dérive évolue lentement (autorégressive, persistance `phi`) : le marché alterne des phases de hausse
   * et de baisse qui durent des dizaines de barres. Cas témoin favorable à une stratégie de tendance ou de cassure.
   * `phi` proche de 1 = tendances longues (défaut 0.98, durée caractéristique ≈ 50 barres).
   */
  phi?: number;
  /**
   * "mix" : le marché alterne, par segments, des phases de retour à la moyenne (comme "ou") et des phases de tendance
   * (comme "mom"), tirées au hasard. Un avantage n'y existe que dans certaines phases : cas témoin pour un avantage
   * CONDITIONNEL à une situation. Durée moyenne d'une phase : `segment` barres (défaut 500).
   */
  segment?: number;
  /** "mom" : amplitude des tendances, en multiples de `vol` (défaut 0.15 : dérive typique de ±0,15 écart-type par barre). */
  trend?: number;
}

/** Mouvement brownien géométrique : les prix restent strictement positifs. */
export function syntheticPrices(o: SyntheticOptions): number[] {
  const { n, seed, start = 100, drift = 0, vol = 0.01, model = "gbm", theta = 0.05, phi = 0.98, trend = 0.15, segment = 500 } = o;
  if (!Number.isInteger(n) || n < 2) throw new Error("n doit être un entier >= 2");
  if (model !== "gbm" && model !== "ou" && model !== "mom" && model !== "mix") throw new Error(`modèle inconnu : ${model} (gbm | ou | mom | mix)`);
  if (!(segment >= 50)) throw new Error("segment doit être >= 50");
  if (!(phi > -1 && phi < 1)) throw new Error("phi doit être dans ]-1, 1[");
  if (!(trend >= 0)) throw new Error("trend doit être >= 0");
  if (!(theta > 0 && theta <= 1)) throw new Error("theta doit être dans ]0, 1]");
  const rnd = mulberry32(seed);
  const normal = () => {
    const u = Math.max(rnd(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  if (model === "mix") {
    const eta = trend * vol * Math.sqrt(1 - phi * phi);
    const segLen = () => Math.max(50, Math.round(segment * (0.5 + rnd())));
    let x = Math.log(start);
    let anchor = x;
    let mu = 0;
    let kind: "ou" | "trend" = rnd() < 0.5 ? "ou" : "trend";
    let left = segLen();
    const out = [start];
    for (let i = 1; i < n; i++) {
      if (left <= 0) {
        kind = rnd() < 0.5 ? "ou" : "trend";
        anchor = x;
        mu = 0;
        left = segLen();
      }
      if (kind === "ou") x = x + theta * (anchor - x) + vol * normal();
      else {
        mu = phi * mu + eta * normal();
        x = x + mu - (vol * vol) / 2 + vol * normal();
      }
      out.push(Math.exp(x));
      left--;
    }
    return out;
  }
  if (model === "mom") {
    const out = [start];
    const eta = trend * vol * Math.sqrt(1 - phi * phi); // écart-type de la dérive = trend x vol
    let mu = 0;
    for (let i = 1; i < n; i++) {
      mu = phi * mu + eta * normal();
      out.push(out[i - 1] * Math.exp(drift + mu - (vol * vol) / 2 + vol * normal()));
    }
    return out;
  }
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
