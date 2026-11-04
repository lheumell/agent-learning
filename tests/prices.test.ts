import { describe, expect, it } from "vitest";
import {
  PythSource,
  StaticSource,
  assertQuality,
  getCheckedPrice,
  normalizeSymbol,
  type PriceQuote,
} from "../src/prices.js";

const NOW = new Date("2026-01-01T12:00:00Z");
const quote = (over: Partial<PriceQuote> = {}): PriceQuote => ({
  symbol: "ETH", priceUsd: 3000, confidenceUsd: 3, publishedAt: NOW, source: "t", ...over,
});

describe("normalizeSymbol", () => {
  it("normalise la casse", () => expect(normalizeSymbol(" eth ")).toBe("ETH"));
  it("refuse l'injection d'URL", () => {
    for (const bad of ["ETH&x=1", "../etc", "ETH/USD", "", "A", "TOOLONGSYMBOL1"]) {
      expect(() => normalizeSymbol(bad)).toThrow(/invalide/);
    }
  });
});

describe("assertQuality", () => {
  const limits = { maxAgeSec: 60, maxConfidenceRatio: 0.01 };
  it("accepte un prix frais et précis", () => expect(() => assertQuality(quote(), limits, NOW)).not.toThrow());
  it("refuse un prix périmé", () => {
    const old = quote({ publishedAt: new Date(NOW.getTime() - 120_000) });
    expect(() => assertQuality(old, limits, NOW)).toThrow(/périmé/);
  });
  it("refuse un prix trop incertain", () => {
    expect(() => assertQuality(quote({ confidenceUsd: 100 }), limits, NOW)).toThrow(/incertain/);
  });
  it("refuse un prix nul ou NaN", () => {
    expect(() => assertQuality(quote({ priceUsd: 0 }), limits, NOW)).toThrow(/invalide/);
    expect(() => assertQuality(quote({ priceUsd: NaN }), limits, NOW)).toThrow(/invalide/);
  });
});

describe("PythSource (réponses simulées)", () => {
  // Extraits d'une vraie réponse de Hermes pour ?query=eth&asset_type=crypto (pas de champ `base`).
  const feed = (id: string, symbol: string, quote: string) => ({
    id,
    market_hours: { is_open: true, next_open: null, next_close: null },
    attributes: { asset_type: "Crypto", quote_currency: quote, symbol, display_symbol: symbol.replace(/[./]/g, "").replace("Crypto", "") },
  });
  const feeds = [
    feed("ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", "Crypto.ETH/USD", "USD"),
    feed("b27578a9654246cb0a2950842b92330e9ace141c52b63829cc72d5c45a5a595a", "Crypto.ETHFI/USD", "USD"),
    feed("15ecddd26d49e1a8f1de9376ebebc03916ede873447c1255d2d5891b92ce5717", "Crypto.CBETH/USD", "USD"),
    feed("c96458d393fe9deb7a7d63a0ac41e2898a67a7750dbd166673279e06c868df0a", "Crypto.ETH/BTC", "BTC"),
  ];
  const latest = { parsed: [{ price: { price: "300012345678", conf: "150000000", expo: -8, publish_time: 1767268800 } }] };

  function fakeFetch(calls: string[]) {
    return (async (url: string) => {
      calls.push(url);
      const body = url.includes("/v2/price_feeds") ? feeds : latest;
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
  }

  it("choisit le flux exact ETH/USD et applique l'exposant", async () => {
    const calls: string[] = [];
    const q = await new PythSource(fakeFetch(calls)).getPrice("eth");
    expect(calls[1]).toContain("ids[]=ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"); // ETH/USD, pas ETHFI, CBETH ni ETH/BTC
    expect(q.priceUsd).toBeCloseTo(3000.12345678, 6);
    expect(q.confidenceUsd).toBeCloseTo(1.5, 6);
    expect(q.publishedAt.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });
  it("met l'identifiant en cache", async () => {
    const calls: string[] = [];
    const src = new PythSource(fakeFetch(calls));
    await src.getPrice("ETH");
    await src.getPrice("ETH");
    expect(calls.filter((c) => c.includes("/v2/price_feeds"))).toHaveLength(1);
  });
  it("échoue clairement si le flux n'existe pas, en listant ce qui a été reçu", async () => {
    const f = (async () => ({ ok: true, status: 200, json: async () => feeds }) as Response) as unknown as typeof fetch;
    await expect(new PythSource(f).getPrice("ZZZ")).rejects.toThrow(/Crypto\.ZZZ\/USD.*4 flux reçus.*Crypto\.ETH\/USD/);
  });
  it("signale une réponse vide ou inattendue", async () => {
    for (const body of [[], { error: "x" }]) {
      const f = (async () => ({ ok: true, status: 200, json: async () => body }) as Response) as unknown as typeof fetch;
      await expect(new PythSource(f).getPrice("ETH")).rejects.toThrow(/aucun flux.*(vide|inattendue)/);
    }
  });
  it("ne confond pas ETH avec ETHFI, CBETH ni ETH/BTC", async () => {
    const only = feeds.filter((f) => f.attributes.symbol !== "Crypto.ETH/USD");
    const f = (async () => ({ ok: true, status: 200, json: async () => only }) as Response) as unknown as typeof fetch;
    await expect(new PythSource(f).getPrice("ETH")).rejects.toThrow(/aucun flux/);
  });
  it("échoue clairement sur une réponse inattendue", async () => {
    const f = (async (u: string) =>
      ({ ok: true, status: 200, json: async () => (u.includes("price_feeds") ? feeds : { parsed: [] }) }) as Response) as unknown as typeof fetch;
    await expect(new PythSource(f).getPrice("ETH")).rejects.toThrow(/inattendue/);
  });
  it("échoue sur une erreur HTTP", async () => {
    const f = (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
    await expect(new PythSource(f).getPrice("ETH")).rejects.toThrow(/HTTP 503/);
  });
});

describe("getCheckedPrice + StaticSource", () => {
  it("retourne le prix statique", async () => {
    const q = await getCheckedPrice(new StaticSource({ ETH: 2500 }), "eth");
    expect(q.priceUsd).toBe(2500);
  });
  it("signale un symbole inconnu", async () => {
    await expect(getCheckedPrice(new StaticSource({}), "ETH")).rejects.toThrow(/pas de prix/);
  });
});
