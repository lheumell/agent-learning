import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardServer, listSymbols, paperPayload, readJsonl } from "../src/dashboard.js";
import { dashboardCommand } from "../src/dashboard-cli.js";
import { PaperTrader } from "../src/paper.js";
import type { PriceQuote, PriceSource } from "../src/prices.js";
import { syntheticPrices } from "../src/simulate.js";
import { ZScoreReversion } from "../src/strategy.js";

class SeriesSource implements PriceSource {
  calls = 0;
  constructor(private prices: number[], private failAt = new Set<number>()) {}
  async getPrice(symbol: string): Promise<PriceQuote> {
    const i = this.calls++;
    if (this.failAt.has(i)) throw new Error("réseau indisponible");
    return { symbol, priceUsd: this.prices[i], confidenceUsd: 0, publishedAt: new Date(), source: "series" };
  }
}

const prices = syntheticPrices({ n: 400, seed: 4, model: "ou" });
let dir: string;
let server: Server;
let base: string;
let trader: PaperTrader;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dash-"));
  trader = PaperTrader.open({
    symbol: "ETH",
    makeStrategy: () => new ZScoreReversion(20, 1.5, 0),
    source: new SeriesSource(prices, new Set([5, 50])),
    statePath: join(dir, "paper-ETH.json"),
    journalPath: join(dir, "paper-ETH.jsonl"),
  });
  for (let i = 0; i < 400; i++) await trader.tick();
  writeFileSync(
    join(dir, "audit.jsonl"),
    JSON.stringify({ t: "2026-01-01T00:00:00Z", event: "denied", reason: "plafond", to: "0xabc", valueWei: "5" }) + "\n",
  );
  server = createDashboardServer({ dataDir: dir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** fetch interdit de fixer l'en-tête Host : on passe par node:http pour tester le cas hostile. */
function raw(path: string, opts: { method?: string; host?: string } = {}) {
  const port = (server.address() as AddressInfo).port;
  return new Promise<{ status: number; body: string; headers: Record<string, any> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { Host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}
const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, json: await r.json() as any };
};

describe("API", () => {
  it("liste les symboles disponibles", async () => {
    expect((await get("/api/symbols")).json).toEqual({ symbols: ["ETH"] });
  });
  it("renvoie le statut, la courbe de capital et les trades du mode papier", async () => {
    const { status, json } = await get("/api/paper/eth");
    expect(status).toBe(200);
    expect(json.status.symbol).toBe("ETH");
    expect(json.status.ticks).toBe(trader.status().ticks);
    expect(json.status.equity).toBeCloseTo(trader.status().equity, 9);
    expect(json.series.length).toBe(trader.status().ticks); // 398 < 600 : pas de sous-échantillonnage
    expect(json.series[0].buyHold).toBeCloseTo(1000 * (1 / (1.0005 * 1.001)) * (json.series[0].price / json.series[0].price), 6);
    expect(json.trades.length).toBeGreaterThan(0);
    expect(json.trades.length).toBe(Math.min(50, trader.status().trades));
    expect(json.skipped).toHaveLength(2);
    expect(json.skipped[0].reason).toMatch(/réseau/);
    expect(json.lastTickAt).toBeTruthy();
  });
  it("les trades sont du plus récent au plus ancien", async () => {
    const { json } = await get("/api/paper/ETH");
    const ts = json.trades.map((t: any) => Date.parse(t.t));
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
  });
  it("le journal du garde-fou est exposé", async () => {
    const { json } = await get("/api/guard");
    expect(json.rows[0]).toMatchObject({ event: "denied", reason: "plafond" });
  });
  it("/healthz répond", async () => {
    expect((await get("/healthz")).json).toEqual({ ok: true });
  });
  it("sous-échantillonne au-delà de 600 points en gardant les extrémités", () => {
    const d = mkdtempSync(join(tmpdir(), "dash-big-"));
    const first = { t: "2026-01-01T00:00:00Z", event: "tick", tick: 1, price: 100, equity: 1000 };
    const lines = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ ...first, tick: i + 1, t: new Date(1e12 + i * 1000).toISOString(), price: 100 + i }));
    writeFileSync(join(d, "paper-BIG.jsonl"), lines.join("\n") + "\n");
    writeFileSync(join(d, "paper-BIG.json"), readStateOf());
    const p = paperPayload(d, "BIG");
    expect(p.series).toHaveLength(600);
    expect(p.series[0].price).toBe(100);
    expect(p.series.at(-1)!.price).toBe(100 + 2999);
  });
});

function readStateOf() {
  return require("node:fs").readFileSync(join(dir, "paper-ETH.json"), "utf8");
}

describe("sécurité", () => {
  it("refuse un symbole invalide ou une tentative de remonter l'arborescence", async () => {
    expect((await raw("/api/paper/..%2F..%2Fetc%2Fpasswd")).status).toBe(400);
    expect((await raw("/api/paper/ETH%2e%2e")).status).toBe(400);
    expect((await raw("/api/paper/E")).status).toBe(400);
    expect((await raw("/api/paper/ETH%00")).status).toBe(400);
  });
  it("404 propre pour un symbole sans données, avec la commande à lancer", async () => {
    const r = await raw("/api/paper/BTC");
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error).toMatch(/npm run paper/);
  });
  it("refuse tout sauf GET/HEAD", async () => {
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) expect((await raw("/api/symbols", { method: m })).status).toBe(405);
  });
  it("refuse un en-tête Host non local (DNS rebinding)", async () => {
    expect((await raw("/api/symbols", { host: "evil.example.com" })).status).toBe(403);
    expect((await raw("/api/symbols", { host: "evil.example.com:8787" })).status).toBe(403);
    expect((await raw("/", { host: "attacker.test" })).status).toBe(403);
  });
  it("accepte localhost et 127.0.0.1", async () => {
    expect((await raw("/healthz", { host: "localhost:8787" })).status).toBe(200);
    expect((await raw("/healthz", { host: "127.0.0.1" })).status).toBe(200);
    expect((await raw("/healthz", { host: "[::1]:8787" })).status).toBe(200);
  });
  it("la page porte une CSP stricte dont le nonce correspond aux balises", async () => {
    const r = await raw("/");
    expect(r.status).toBe(200);
    const csp = String(r.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(r.body).toContain(`<script nonce="${nonce}">`);
    expect(r.body).toContain(`<style nonce="${nonce}">`);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect((await raw("/")).headers["content-security-policy"]).not.toBe(csp); // nonce différent à chaque requête
  });
  it("la page n'appelle aucune ressource externe et n'insère jamais de données via innerHTML", async () => {
    const html = (await raw("/")).body;
    expect(html).not.toMatch(/(src|href)=["']https?:/);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
  it("ne renvoie ni trace d'appel ni chemin système en cas d'erreur", async () => {
    writeFileSync(join(dir, "paper-BAD.json"), "{pas du json");
    const r = await raw("/api/paper/BAD");
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body).error).toMatch(/illisible ou corrompu : <chemin>/);
    expect(r.body).not.toMatch(/\n\s+at |node_modules/); // pas de trace d'appel
    expect(r.body).not.toContain(dir); // pas de chemin système
  });
  it("tolère un journal dont des lignes sont corrompues ou injectent du HTML (rendu en texte seulement)", () => {
    const d = mkdtempSync(join(tmpdir(), "dash-evil-"));
    writeFileSync(join(d, "x.jsonl"), '{"event":"skipped","reason":"<img src=x onerror=alert(1)>"}\nnot json\n{"event":"tick"\n');
    const rows = readJsonl(join(d, "x.jsonl"));
    expect(rows).toHaveLength(1); // la donnée reste du texte : c'est le rendu (textContent) qui la neutralise
    expect(rows[0].reason).toContain("<img");
  });
  it("404 pour les autres chemins", async () => {
    expect((await raw("/etc/passwd")).status).toBe(404);
    expect((await raw("/api/unknown")).status).toBe(404);
  });
});

describe("utilitaires", () => {
  it("listSymbols ignore les fichiers étrangers et un dossier absent", () => {
    const d = mkdtempSync(join(tmpdir(), "dash-ls-"));
    for (const f of ["paper-ETH.json", "paper-BTC.json", "paper-eth.json", "paper-ETH.jsonl", "paper-.json", "notes.json", "paper-A-B.json"]) writeFileSync(join(d, f), "{}");
    expect(listSymbols(d)).toEqual(["BTC", "ETH"]);
    expect(listSymbols(join(d, "nope"))).toEqual([]);
  });
  it("readJsonl ne lit que la fin d'un gros fichier", () => {
    const d = mkdtempSync(join(tmpdir(), "dash-jl-"));
    const f = join(d, "a.jsonl");
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < 2000; i++) appendFileSync(f, JSON.stringify({ i }) + "\n");
    const rows = readJsonl(f, 2000);
    expect(rows.length).toBeLessThan(2000);
    expect(rows.at(-1)!.i).toBe(1999);
    expect(rows.every((r) => typeof r.i === "number")).toBe(true); // première ligne coupée écartée
  });
  it("renvoie une liste vide si le fichier n'existe pas", () => {
    expect(readJsonl("/nonexistent/x.jsonl")).toEqual([]);
  });
});

describe("dashboardCommand", () => {
  it("affiche l'aide et valide le port", async () => {
    const out: string[] = [];
    await dashboardCommand(["--help"], (s) => out.push(s));
    expect(out.join()).toMatch(/lecture seule/i);
    await expect(dashboardCommand(["--port", "99999"], () => {})).rejects.toThrow(/entier entre 1 et 65535/);
    await expect(dashboardCommand(["--port", "abc"], () => {})).rejects.toThrow(/entier/);
  });
});
