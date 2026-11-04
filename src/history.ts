/**
 * Import de bougies historiques depuis l'API publique de Coinbase Exchange (sans clé).
 *   GET /products/{PRODUCT}/candles?start=ISO&end=ISO&granularity=SECONDES
 *   -> [[time, low, high, open, close, volume], ...] du plus récent au plus ancien, 300 bougies max.
 *
 * ⚠ Écrit d'après la documentation et testé contre un faux serveur : PAS contre l'API réelle
 * (réseau bloqué lors de l'écriture). Premier essai réel : `npm run history -- --days 3`.
 */
export interface Candle {
  /** Début de la bougie, en secondes Unix. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const GRANULARITIES = [60, 300, 900, 3600, 21600, 86400] as const;
export type Granularity = (typeof GRANULARITIES)[number];

const MAX_PER_REQUEST = 300;
/** Garde-fou : on refuse un import qui demanderait plus de requêtes que ça. */
export const MAX_REQUESTS = 400;

export interface FetchOptions {
  product: string;
  granularity: number;
  /** Secondes Unix. */
  start: number;
  /** Secondes Unix (exclu). */
  end: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Heure courante en secondes Unix (injectable pour les tests). */
  nowSec?: number;
  baseUrl?: string;
  pauseMs?: number;
  maxRetries?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface HistoryReport {
  candles: number;
  first: string;
  last: string;
  expected: number;
  missing: number;
  /** Plus longue séquence consécutive de bougies manquantes. */
  longestGap: number;
  gapStarts: string[];
  duplicatesRemoved: number;
  droppedUnfinished: number;
  requests: number;
}

export function validateProduct(product: string): string {
  const p = product.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}-[A-Z]{2,5}$/.test(p)) throw new Error(`produit invalide : "${product}" (ex. ETH-USD)`);
  return p;
}

export function validateGranularity(g: number): Granularity {
  if (!(GRANULARITIES as readonly number[]).includes(g)) {
    throw new Error(`granularité invalide : ${g} (autorisées : ${GRANULARITIES.join(", ")} secondes)`);
  }
  return g as Granularity;
}

export function parseCandleRow(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 6) throw new Error("ligne de bougie inattendue");
  const [time, low, high, open, close, volume] = row.map(Number);
  const all = [time, low, high, open, close, volume];
  if (!all.every(Number.isFinite)) throw new Error("bougie avec valeur non numérique");
  if (open <= 0 || close <= 0 || high <= 0 || low <= 0) throw new Error(`bougie avec prix non positif (t=${time})`);
  if (high < low) throw new Error(`bougie incohérente : high < low (t=${time})`);
  return { time, open, high, low, close, volume };
}

const iso = (sec: number) => new Date(sec * 1000).toISOString();

export async function fetchCandles(o: FetchOptions): Promise<{ candles: Candle[]; report: HistoryReport }> {
  const product = validateProduct(o.product);
  const g = validateGranularity(o.granularity);
  const fetchFn = o.fetchFn ?? ((...a) => fetch(...a));
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowSec = o.nowSec ?? Math.floor(Date.now() / 1000);
  const baseUrl = o.baseUrl ?? "https://api.exchange.coinbase.com";
  const pauseMs = o.pauseMs ?? 350;
  const maxRetries = o.maxRetries ?? 4;

  if (!Number.isFinite(o.start) || !Number.isFinite(o.end)) throw new Error("dates invalides");
  // Alignement sur les frontières de bougie (époque Unix), pour ne pas demander de bougie partielle.
  const start = Math.ceil(o.start / g) * g;
  const end = Math.floor(Math.min(o.end, nowSec) / g) * g;
  if (start >= end) throw new Error("plage vide : start doit être strictement avant end (et dans le passé)");

  const span = MAX_PER_REQUEST * g;
  const totalRequests = Math.ceil((end - start) / span);
  if (totalRequests > MAX_REQUESTS) {
    throw new Error(`plage trop large : ${totalRequests} requêtes (max ${MAX_REQUESTS}). Réduisez la période ou augmentez la granularité.`);
  }

  const byTime = new Map<number, Candle>();
  let duplicates = 0;
  let requests = 0;

  for (let s = start; s < end; s += span) {
    const e = Math.min(s + span - g, end - g); // dernière bougie demandée : début = e
    const url =
      `${baseUrl}/products/${product}/candles?start=${encodeURIComponent(iso(s))}` +
      `&end=${encodeURIComponent(iso(e))}&granularity=${g}`;

    let rows: unknown;
    for (let attempt = 0; ; attempt++) {
      requests++;
      const res = await fetchFn(url, { headers: { "User-Agent": "agent-learning-history", Accept: "application/json" } });
      if (res.ok) {
        rows = await res.json();
        break;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        let detail = "";
        try {
          detail = ` — ${JSON.stringify(await res.json()).slice(0, 200)}`;
        } catch {
          /* pas de corps JSON */
        }
        throw new Error(`HTTP ${res.status} sur ${product}${detail}`);
      }
      await sleep(Math.min(8000, 500 * 2 ** attempt)); // 0,5 s, 1 s, 2 s, 4 s
    }

    if (!Array.isArray(rows)) throw new Error("réponse inattendue : un tableau de bougies était attendu");
    for (const row of rows) {
      const c = parseCandleRow(row);
      if (c.time < start || c.time >= end) continue; // hors plage demandée
      if (byTime.has(c.time)) duplicates++;
      byTime.set(c.time, c);
    }
    o.onProgress?.(Math.min(totalRequests, Math.floor((s - start) / span) + 1), totalRequests);
    if (s + span < end) await sleep(pauseMs);
  }

  const all = [...byTime.values()].sort((a, b) => a.time - b.time);
  // Une bougie dont la fin est dans le futur n'est pas terminée : son close changerait encore.
  const finished = all.filter((c) => c.time + g <= nowSec);
  const dropped = all.length - finished.length;
  if (finished.length < 2) throw new Error("moins de 2 bougies terminées dans cette plage");

  return { candles: finished, report: buildReport(finished, g, duplicates, dropped, requests) };
}

export function buildReport(candles: Candle[], g: number, duplicates = 0, dropped = 0, requests = 0): HistoryReport {
  const first = candles[0].time;
  const last = candles[candles.length - 1].time;
  const expected = Math.floor((last - first) / g) + 1;
  const gapStarts: string[] = [];
  let longest = 0;
  let missing = 0;
  for (let i = 1; i < candles.length; i++) {
    const gap = (candles[i].time - candles[i - 1].time) / g - 1;
    if (gap > 0) {
      missing += gap;
      longest = Math.max(longest, gap);
      if (gapStarts.length < 5) gapStarts.push(iso(candles[i - 1].time + g));
    }
  }
  return {
    candles: candles.length,
    first: iso(first),
    last: iso(last),
    expected,
    missing,
    longestGap: longest,
    gapStarts,
    duplicatesRemoved: duplicates,
    droppedUnfinished: dropped,
    requests,
  };
}

/** CSV lisible par `--csv` du backtest et du walk-forward (colonne « close »). */
export function candlesToCsv(candles: Candle[]): string {
  const lines = ["time,open,high,low,close,volume"];
  for (const c of candles) lines.push(`${iso(c.time)},${c.open},${c.high},${c.low},${c.close},${c.volume}`);
  return lines.join("\n") + "\n";
}
