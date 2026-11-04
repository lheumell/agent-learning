import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backtestCommand } from "../src/backtest-cli.js";
import { buildReport, candlesToCsv, fetchCandles, parseCandleRow, MAX_REQUESTS } from "../src/history.js";
import { historyCommand } from "../src/history-cli.js";
import { parseCsvPrices, syntheticPrices } from "../src/simulate.js";

const G = 3600;
const T0 = Math.floor(1_700_000_000 / G) * G;
const closes = syntheticPrices({ n: 1000, seed: 9, vol: 0.01 });
const row = (i: number) => [T0 + i * G, closes[i] * 0.99, closes[i] * 1.01, closes[i], closes[i], 10 + i];

interface FakeOpts {
  /** Indices de bougies que le serveur « n'a pas » (pas de transactions). */
  omit?: Set<number>;
  /** Statuts renvoyés avant de répondre normalement. */
  failures?: number[];
  /** Renvoie aussi la bougie juste après `end` (frontière inclusive). */
  leaky?: boolean;
}

/** Imite Coinbase : plus récent d'abord, 300 bougies max par requête, 400 si la plage est trop grande. */
function fakeServer(count = 1000, o: FakeOpts = {}) {
  const calls: string[] = [];
  const failures = [...(o.failures ?? [])];
  const fn = (async (url: string) => {
    calls.push(url);
    const status = failures.shift();
    if (status) return { ok: false, status, json: async () => ({ message: `erreur ${status}` }) } as Response;
    const u = new URL(url);
    const start = Date.parse(u.searchParams.get("start")!) / 1000;
    const end = Date.parse(u.searchParams.get("end")!) / 1000;
    const g = Number(u.searchParams.get("granularity"));
    if ((end - start) / g + 1 > 300) {
      return { ok: false, status: 400, json: async () => ({ message: "granularity too small for the requested time range" }) } as Response;
    }
    const rows: unknown[][] = [];
    for (let i = 0; i < count; i++) {
      const t = T0 + i * g;
      if (o.omit?.has(i)) continue;
      if (t >= start && (t <= end || (o.leaky && t === end + g))) rows.push(row(i));
    }
    return { ok: true, status: 200, json: async () => rows.reverse() } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const noSleep = async () => {};
const base = (srv: ReturnType<typeof fakeServer>, over = {}) => ({
  product: "ETH-USD",
  granularity: G,
  start: T0,
  end: T0 + 1000 * G,
  nowSec: T0 + 5000 * G,
  fetchFn: srv.fn,
  sleep: noSleep,
  ...over,
});

describe("fetchCandles", () => {
  it("pagine par 300 bougies et rend une série complète, triée, sans doublon", async () => {
    const srv = fakeServer();
    const { candles, report } = await fetchCandles(base(srv));
    expect(candles).toHaveLength(1000);
    expect(report.requests).toBe(4);
    expect(candles.every((c, i) => c.time === T0 + i * G && c.close === closes[i])).toBe(true);
    expect(report.missing).toBe(0);
    expect(report.duplicatesRemoved).toBe(0);
  });
  it("ne demande jamais plus de 300 bougies par requête", async () => {
    const srv = fakeServer();
    await expect(fetchCandles(base(srv))).resolves.toBeTruthy(); // le faux serveur répond 400 sinon
  });
  it("supprime les doublons aux frontières de fenêtre", async () => {
    const srv = fakeServer(1000, { leaky: true });
    const { candles, report } = await fetchCandles(base(srv));
    expect(candles).toHaveLength(1000);
    expect(report.duplicatesRemoved).toBeGreaterThan(0);
  });
  it("ignore la bougie encore en cours (son close n'est pas définitif)", async () => {
    const srv = fakeServer();
    // « maintenant » tombe au milieu de la bougie 499
    const { candles, report } = await fetchCandles(base(srv, { end: T0 + 500 * G, nowSec: T0 + 499 * G + 1800 }));
    expect(candles.at(-1)!.time).toBe(T0 + 498 * G);
    expect(report.last).toBe(new Date((T0 + 498 * G) * 1000).toISOString());
  });
  it("signale les bougies manquantes et la plus longue séquence", async () => {
    const omit = new Set([100, 101, 102, 103, 104, 400, 700]);
    const { report } = await fetchCandles(base(fakeServer(1000, { omit })));
    expect(report.missing).toBe(7);
    expect(report.longestGap).toBe(5);
    expect(report.gapStarts[0]).toBe(new Date((T0 + 100 * G) * 1000).toISOString());
    expect(report.expected).toBe(1000);
  });
  it("réessaie après 429 avec un délai croissant", async () => {
    const sleeps: number[] = [];
    const srv = fakeServer(100, { failures: [429, 503] });
    const { candles } = await fetchCandles(base(srv, { end: T0 + 100 * G, sleep: async (ms: number) => void sleeps.push(ms) }));
    expect(candles).toHaveLength(100);
    expect(sleeps).toEqual([500, 1000]);
  });
  it("abandonne après trop d'échecs", async () => {
    const srv = fakeServer(100, { failures: [429, 429, 429, 429, 429, 429] });
    await expect(fetchCandles(base(srv, { end: T0 + 100 * G }))).rejects.toThrow(/HTTP 429/);
  });
  it("ne réessaie pas une erreur client et affiche le message du serveur", async () => {
    const srv = fakeServer(100, { failures: [400] });
    await expect(fetchCandles(base(srv, { end: T0 + 100 * G }))).rejects.toThrow(/HTTP 400.*erreur 400/);
    expect(srv.calls).toHaveLength(1);
  });
  it("aligne le début sur une frontière de bougie", async () => {
    const { candles } = await fetchCandles(base(fakeServer(), { start: T0 + 10, end: T0 + 50 * G }));
    expect(candles[0].time).toBe(T0 + G);
  });
  it("valide les entrées", async () => {
    const srv = fakeServer();
    await expect(fetchCandles(base(srv, { product: "ETH/USD&x=1" }))).rejects.toThrow(/produit invalide/);
    await expect(fetchCandles(base(srv, { granularity: 7 }))).rejects.toThrow(/granularité invalide/);
    await expect(fetchCandles(base(srv, { start: T0 + 100, end: T0 + 100 }))).rejects.toThrow(/plage vide/);
    await expect(fetchCandles(base(srv, { start: T0, end: T0 + (MAX_REQUESTS + 5) * 300 * G, nowSec: T0 + 1e9 }))).rejects.toThrow(/trop large/);
    expect(srv.calls).toHaveLength(0); // rien n'est demandé si l'entrée est invalide
  });
  it("refuse une réponse mal formée", async () => {
    const bad = (async () => ({ ok: true, status: 200, json: async () => ({ message: "hello" }) }) as Response) as unknown as typeof fetch;
    await expect(fetchCandles(base({ fn: bad, calls: [] }, { end: T0 + 10 * G }))).rejects.toThrow(/tableau/);
  });
});

describe("parseCandleRow", () => {
  it("accepte une ligne valide", () => {
    expect(parseCandleRow([1, 9, 11, 10, 10.5, 3])).toEqual({ time: 1, low: 9, high: 11, open: 10, close: 10.5, volume: 3 });
  });
  it("refuse les lignes douteuses", () => {
    expect(() => parseCandleRow([1, 2, 3])).toThrow(/inattendue/);
    expect(() => parseCandleRow([1, "x", 11, 10, 10, 3])).toThrow(/non numérique/);
    expect(() => parseCandleRow([1, 9, 11, 0, 10, 3])).toThrow(/non positif/);
    expect(() => parseCandleRow([1, 12, 11, 10, 10, 3])).toThrow(/high < low/);
    expect(() => parseCandleRow(null)).toThrow(/inattendue/);
  });
});

describe("candlesToCsv", () => {
  it("produit un CSV relu tel quel par le backtest", async () => {
    const { candles } = await fetchCandles(base(fakeServer(), { end: T0 + 300 * G }));
    const csv = candlesToCsv(candles);
    expect(csv.split("\n")[0]).toBe("time,open,high,low,close,volume");
    expect(parseCsvPrices(csv)).toEqual(closes.slice(0, 300));
  });
  it("buildReport compte correctement sans trou", () => {
    const r = buildReport([{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { time: G, open: 1, high: 1, low: 1, close: 1, volume: 1 }], G);
    expect(r).toMatchObject({ candles: 2, expected: 2, missing: 0 });
  });
});

describe("historyCommand", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "hist-"));
  const run = async (args: string[], srv = fakeServer(), nowSec = T0 + 5000 * G) => {
    const out: string[] = [];
    await historyCommand(args, (s) => out.push(s), { fetchFn: srv.fn, sleep: noSleep, nowSec });
    return out.join("\n");
  };
  const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

  it("affiche l'aide", async () => expect(await run(["--help"])).toMatch(/Usage/));

  it("écrit le CSV puis le backtest peut le lire de bout en bout", async () => {
    const file = join(dir(), "eth.csv");
    const txt = await run(["--start", isoDay(T0), "--end", isoDay(T0 + 40 * 86400), "--out", file]);
    expect(txt).toMatch(/aucune bougie manquante/);
    expect(existsSync(file)).toBe(true);
    const out: string[] = [];
    backtestCommand(["--csv", file, "--fast", "3", "--slow", "8"], (s) => out.push(s));
    expect(out.join("\n")).toMatch(/SMA\(3\/8\)/);
  });
  it("refuse d'écraser un fichier sans --force", async () => {
    const file = join(dir(), "x.csv");
    writeFileSync(file, "ancien");
    const soon = T0 + 300 * G; // « maintenant » : les 5 derniers jours contiennent des données
    await expect(run(["--days", "5", "--out", file], fakeServer(), soon)).rejects.toThrow(/existe déjà/);
    expect(readFileSync(file, "utf8")).toBe("ancien");
    await run(["--days", "5", "--out", file, "--force"], fakeServer(), soon);
    expect(readFileSync(file, "utf8")).toMatch(/^time,open/);
  });
  it("--strict n'écrit rien s'il manque des bougies", async () => {
    const file = join(dir(), "gap.csv");
    const srv = fakeServer(1000, { omit: new Set([20, 21]) });
    await expect(run(["--start", isoDay(T0), "--end", isoDay(T0 + 4 * 86400), "--out", file, "--strict"], srv)).rejects.toThrow(/manquante/);
    expect(existsSync(file)).toBe(false);
  });
  it("sans --strict, avertit mais écrit", async () => {
    const file = join(dir(), "gap2.csv");
    const srv = fakeServer(1000, { omit: new Set([20, 21]) });
    const txt = await run(["--start", isoDay(T0), "--end", isoDay(T0 + 4 * 86400), "--out", file], srv);
    expect(txt).toMatch(/⚠ 2 bougie\(s\) manquante/);
    expect(existsSync(file)).toBe(true);
  });
  it("valide les arguments", async () => {
    await expect(run(["--days", "-3"])).rejects.toThrow(/positif/);
    await expect(run(["--days", "5", "--start", "2025-01-01"])).rejects.toThrow(/incompatible/);
    await expect(run(["--end", "2025-01-01"])).rejects.toThrow(/demande aussi --start/);
    await expect(run(["--start", "01/02/2025"])).rejects.toThrow(/AAAA-MM-JJ/);
    await expect(run(["--product", "ETH&x"])).rejects.toThrow(/produit invalide/);
    await expect(run(["--granularity", "10"])).rejects.toThrow(/granularité invalide/);
  });
});
