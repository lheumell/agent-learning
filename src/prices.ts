import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod/v3";

// Le schéma est typé `any` à la frontière AgentKit : AgentKit embarque zod 3 et les types profonds
// de zod font exploser tsc (mémoire). Le schéma reste validé à l'exécution.

export interface PriceQuote {
  symbol: string;
  priceUsd: number;
  /** Incertitude (± USD) fournie par la source. */
  confidenceUsd: number;
  publishedAt: Date;
  source: string;
}

export interface PriceSource {
  getPrice(symbol: string): Promise<PriceQuote>;
}

/** Les symboles viennent du LLM : on les valide avant de les mettre dans une URL. */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(s)) throw new Error(`symbole invalide : "${raw}"`);
  return s;
}

export interface QualityLimits {
  /** Un prix plus vieux que ça est refusé (défaut 60 s). */
  maxAgeSec: number;
  /** Refuse si confiance/prix dépasse ce ratio (défaut 1 %). */
  maxConfidenceRatio: number;
}
export const DEFAULT_LIMITS: QualityLimits = { maxAgeSec: 60, maxConfidenceRatio: 0.01 };

/** Contrôle qualité : un prix périmé ou incertain est pire que pas de prix. */
export function assertQuality(q: PriceQuote, limits: QualityLimits, now = new Date()): void {
  if (!Number.isFinite(q.priceUsd) || q.priceUsd <= 0) {
    throw new Error(`${q.symbol} : prix invalide (${q.priceUsd})`);
  }
  const ageSec = (now.getTime() - q.publishedAt.getTime()) / 1000;
  if (ageSec > limits.maxAgeSec) {
    throw new Error(`${q.symbol} : prix périmé (${Math.round(ageSec)} s > ${limits.maxAgeSec} s)`);
  }
  const ratio = q.confidenceUsd / q.priceUsd;
  if (ratio > limits.maxConfidenceRatio) {
    throw new Error(
      `${q.symbol} : prix trop incertain (±${(ratio * 100).toFixed(2)} % > ${limits.maxConfidenceRatio * 100} %)`,
    );
  }
}

type FetchFn = typeof fetch;

/**
 * Prix via Pyth Hermes (API publique, sans clé).
 * Les identifiants de flux sont résolus à l'exécution (pas codés en dur) :
 * on cherche le flux dont attributes.symbol vaut exactement « Crypto.SYMBOL/USD ».
 *
 * Format de /v2/price_feeds validé sur une vraie réponse (fournie par l'utilisateur).
 * Le format de /v2/updates/price/latest (parsed[0].price) reste à confirmer en réel.
 */
export class PythSource implements PriceSource {
  private feedIds = new Map<string, string>();

  constructor(
    private fetchFn: FetchFn = (...a) => fetch(...a),
    private baseUrl = "https://hermes.pyth.network",
  ) {}

  private async getJson(url: string): Promise<any> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`Pyth HTTP ${res.status} sur ${new URL(url).pathname}`);
    return res.json();
  }

  async resolveFeedId(symbol: string): Promise<string> {
    const cached = this.feedIds.get(symbol);
    if (cached) return cached;
    const feeds = await this.getJson(
      `${this.baseUrl}/v2/price_feeds?query=${encodeURIComponent(symbol)}&asset_type=crypto`,
    );
    // Format réel de Hermes : attributes.symbol = "Crypto.ETH/USD" (il n'y a pas de champ `base`).
    // La recherche « eth » renvoie aussi ETHFI/USD, CBETH/USD, ETH/BTC… : il faut une égalité exacte.
    const wanted = `Crypto.${symbol}/USD`;
    const list: any[] = Array.isArray(feeds) ? feeds : [];
    const match = list.find(
      (f) => typeof f?.id === "string" && String(f?.attributes?.symbol ?? "").toUpperCase() === wanted.toUpperCase(),
    );
    if (!match) {
      const seen = list.slice(0, 5).map((f) => f?.attributes?.symbol ?? "?").join(", ");
      throw new Error(
        `aucun flux Pyth ${wanted} trouvé` +
          (list.length ? ` (${list.length} flux reçus, par ex. : ${seen})` : " (réponse vide ou inattendue)"),
      );
    }
    const id = match.id.startsWith("0x") ? match.id.slice(2) : match.id;
    this.feedIds.set(symbol, id);
    return id;
  }

  async getPrice(rawSymbol: string): Promise<PriceQuote> {
    const symbol = normalizeSymbol(rawSymbol);
    const id = await this.resolveFeedId(symbol);
    const data = await this.getJson(
      `${this.baseUrl}/v2/updates/price/latest?ids[]=${id}&parsed=true&encoding=hex`,
    );
    const p = data?.parsed?.[0]?.price;
    if (!p || p.price === undefined || p.expo === undefined || p.publish_time === undefined) {
      throw new Error(`réponse Pyth inattendue pour ${symbol}`);
    }
    const scale = 10 ** Number(p.expo);
    return {
      symbol,
      priceUsd: Number(p.price) * scale,
      confidenceUsd: Number(p.conf ?? 0) * scale,
      publishedAt: new Date(Number(p.publish_time) * 1000),
      source: "pyth-hermes",
    };
  }
}

/** Source déterministe pour les tests et, plus tard, les backtests. */
export class StaticSource implements PriceSource {
  constructor(
    private prices: Record<string, number>,
    private now: () => Date = () => new Date(),
  ) {}
  async getPrice(rawSymbol: string): Promise<PriceQuote> {
    const symbol = normalizeSymbol(rawSymbol);
    const price = this.prices[symbol];
    if (price === undefined) throw new Error(`pas de prix pour ${symbol}`);
    return { symbol, priceUsd: price, confidenceUsd: 0, publishedAt: this.now(), source: "static" };
  }
}

/** Récupère un prix ET vérifie sa qualité. C'est cette fonction que la stratégie doit appeler. */
export async function getCheckedPrice(
  source: PriceSource,
  symbol: string,
  limits: QualityLimits = DEFAULT_LIMITS,
): Promise<PriceQuote> {
  const q = await source.getPrice(symbol);
  assertQuality(q, limits);
  return q;
}

/** Action AgentKit : donne à l'agent un outil `get_price` (lecture seule, ne dépense rien). */
export function priceActionProvider(source: PriceSource, limits: QualityLimits = DEFAULT_LIMITS) {
  return customActionProvider({
    name: "get_price",
    description:
      "Donne le prix actuel en USD d'un actif crypto (ex. ETH, BTC, SOL) avec son horodatage. " +
      "Refuse les prix périmés ou trop incertains. Lecture seule.",
    schema: z.object({ symbol: z.string().describe("Symbole de l'actif, ex. ETH") }) as any,
    invoke: async (args: { symbol: string }) => {
      const q = await getCheckedPrice(source, args.symbol, limits);
      return (
        `${q.symbol}/USD = ${q.priceUsd.toFixed(2)} ` +
        `(±${q.confidenceUsd.toFixed(2)}, publié ${q.publishedAt.toISOString()}, source ${q.source})`
      );
    },
  });
}
