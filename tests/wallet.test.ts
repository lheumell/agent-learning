import "../src/no-telemetry.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { Guard, type GuardConfig } from "../src/guard.js";
import { createWallet } from "../src/wallet.js";

const TO = "0x000000000000000000000000000000000000dEaD" as const;

function setup(over: Partial<GuardConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wallet-"));
  const cfg: GuardConfig = {
    allowedChainIds: [84532],
    maxPerTxWei: parseEther("0.001"),
    maxPerDayWei: parseEther("0.002"),
    allowedRecipients: [],
    dryRun: true,
    killSwitchPath: join(dir, "STOP"),
    statePath: join(dir, "state.json"),
    auditPath: join(dir, "audit.jsonl"),
    ...over,
  };
  // RPC volontairement injoignable : prouve qu'en dry run rien ne part sur le réseau.
  return createWallet(generatePrivateKey(), "http://127.0.0.1:1", new Guard(cfg));
}

describe("GuardedWalletProvider", () => {
  it("dry run : retourne un faux hash sans toucher au réseau", async () => {
    const w = setup();
    const hash = await w.sendTransaction({ to: TO, value: parseEther("0.0005") });
    expect(hash.startsWith("0xdead")).toBe(true);
    const receipt = await w.waitForTransactionReceipt(hash);
    expect(receipt.simulated).toBe(true);
  });
  it("refuse un montant au-dessus du plafond", async () => {
    const w = setup();
    await expect(w.sendTransaction({ to: TO, value: parseEther("0.01") })).rejects.toThrow(/GARDE-FOU/);
  });
  it("refuse un destinataire hors liste blanche", async () => {
    const w = setup({ allowedRecipients: ["0x1111111111111111111111111111111111111111"] });
    await expect(w.sendTransaction({ to: TO, value: 1n })).rejects.toThrow(/liste blanche/);
  });
  it("mode réel : tente d'envoyer (échoue ici car RPC injoignable, mais passe le garde-fou)", async () => {
    const w = setup({ dryRun: false });
    await expect(w.sendTransaction({ to: TO, value: 1n })).rejects.not.toThrow(/GARDE-FOU/);
  });
});
