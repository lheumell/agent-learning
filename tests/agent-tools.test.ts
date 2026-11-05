import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { paperStatusActionProvider } from "../src/agent-tools.js";
import { Guard } from "../src/guard.js";
import { PaperTrader } from "../src/paper.js";
import type { PriceQuote, PriceSource } from "../src/prices.js";
import { syntheticPrices } from "../src/simulate.js";
import { ZScoreReversion } from "../src/strategy.js";
import { createWallet } from "../src/wallet.js";

const prices = syntheticPrices({ n: 300, seed: 6, model: "ou" });
let dir: string;
let invoke: (symbol: string) => Promise<string>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tools-"));
  let i = 0;
  const source: PriceSource = {
    async getPrice(symbol): Promise<PriceQuote> {
      return { symbol, priceUsd: prices[i++], confidenceUsd: 0, publishedAt: new Date(), source: "t" };
    },
  };
  const t = PaperTrader.open({
    symbol: "ETH",
    makeStrategy: () => new ZScoreReversion(20, 1.5, 0),
    source,
    statePath: join(dir, "paper-ETH.json"),
    journalPath: join(dir, "paper-ETH.jsonl"),
  });
  for (let k = 0; k < 300; k++) await t.tick();

  // Le portefeuille hors ligne sert seulement à obtenir les actions AgentKit liées au provider.
  const wallet = createWallet(
    generatePrivateKey(),
    "http://127.0.0.1:1",
    new Guard({ allowedChainIds: [84532], maxPerTxWei: 1n, maxPerDayWei: 1n, allowedRecipients: [], dryRun: true, killSwitchPath: join(dir, "STOP"), statePath: join(dir, "s.json"), auditPath: join(dir, "a.log") }),
  );
  const action = paperStatusActionProvider(dir).getActions(wallet).find((a) => a.name.endsWith("get_paper_status"))!;
  invoke = (symbol) => action.invoke(action.schema.parse({ symbol }));
});

describe("get_paper_status", () => {
  it("résume l'état du trading papier en texte", async () => {
    const txt = await invoke("eth");
    expect(txt).toMatch(/ETH · ZREV\(20\/1\.5\/0\)/);
    expect(txt).toMatch(/capital : .* USD/);
    expect(txt).toMatch(/prix reçus : 300/);
  });
  it("indique les symboles disponibles quand celui demandé n'existe pas", async () => {
    expect(await invoke("BTC")).toMatch(/Aucune donnée.*BTC.*Symboles disponibles : ETH/);
  });
  it("indique comment démarrer quand rien n'existe", async () => {
    const empty = mkdtempSync(join(tmpdir(), "tools-empty-"));
    const wallet = createWallet(generatePrivateKey(), "http://127.0.0.1:1", new Guard({ allowedChainIds: [84532], maxPerTxWei: 1n, maxPerDayWei: 1n, allowedRecipients: [], dryRun: true, killSwitchPath: join(empty, "STOP"), statePath: join(empty, "s.json"), auditPath: join(empty, "a.log") }));
    const a = paperStatusActionProvider(empty).getActions(wallet)[0];
    expect(await a.invoke(a.schema.parse({ symbol: "ETH" }))).toMatch(/npm run paper/);
  });
  it("refuse un symbole piégé avant toute lecture de fichier", async () => {
    await expect(invoke("../../etc/passwd")).rejects.toThrow(/invalide/);
    await expect(invoke("ETH/USD")).rejects.toThrow(/invalide/);
  });
  it("est strictement en lecture seule : aucun fichier créé ni modifié", async () => {
    const before = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    await invoke("ETH");
    await invoke("BTC");
    const after = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    expect(after).toEqual(before);
  });
});
