import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { Guard, type GuardConfig } from "../src/guard.js";

const SEPOLIA = 84532;
const ADDR = "0x000000000000000000000000000000000000dEaD";

function make(over: Partial<GuardConfig> = {}, now = () => new Date("2026-01-01T12:00:00Z")) {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const cfg: GuardConfig = {
    allowedChainIds: [SEPOLIA],
    maxPerTxWei: parseEther("0.001"),
    maxPerDayWei: parseEther("0.003"),
    allowedRecipients: [],
    dryRun: false,
    killSwitchPath: join(dir, "STOP"),
    statePath: join(dir, "state.json"),
    auditPath: join(dir, "audit.jsonl"),
    ...over,
  };
  return { guard: new Guard(cfg, now), cfg };
}
const tx = (eth: string, over = {}) => ({ chainId: SEPOLIA, to: ADDR, valueWei: parseEther(eth), ...over });

describe("Guard", () => {
  it("accepte une petite transaction", () => {
    expect(make().guard.check(tx("0.0005")).ok).toBe(true);
  });
  it("refuse le mainnet", () => {
    const d = make().guard.check(tx("0.0001", { chainId: 8453 }));
    expect(d.ok).toBe(false);
  });
  it("refuse au-delà du plafond par transaction", () => {
    expect(make().guard.check(tx("0.002")).ok).toBe(false);
  });
  it("applique le plafond journalier cumulé", () => {
    const { guard } = make();
    for (let i = 0; i < 3; i++) {
      expect(guard.check(tx("0.001")).ok).toBe(true);
      guard.commit(tx("0.001"));
    }
    expect(guard.check(tx("0.0001")).ok).toBe(false);
  });
  it("remet le compteur le lendemain", () => {
    let d = new Date("2026-01-01T12:00:00Z");
    const { guard } = make({}, () => d);
    for (let i = 0; i < 3; i++) guard.commit(tx("0.001"));
    expect(guard.check(tx("0.001")).ok).toBe(false);
    d = new Date("2026-01-02T00:01:00Z");
    expect(guard.check(tx("0.001")).ok).toBe(true);
  });
  it("respecte la liste blanche (insensible à la casse)", () => {
    const { guard } = make({ allowedRecipients: [ADDR.toLowerCase()] });
    expect(guard.check(tx("0.0001")).ok).toBe(true);
    expect(guard.check(tx("0.0001", { to: "0x1111111111111111111111111111111111111111" })).ok).toBe(false);
  });
  it("refuse une création de contrat si liste blanche active", () => {
    const { guard } = make({ allowedRecipients: [ADDR] });
    expect(guard.check(tx("0", { to: undefined })).ok).toBe(false);
  });
  it("kill switch bloque tout", () => {
    const { guard, cfg } = make();
    writeFileSync(cfg.killSwitchPath, "");
    expect(guard.check(tx("0.0001")).ok).toBe(false);
  });
  it("dry run : autorisé mais ne consomme pas le budget", () => {
    const { guard } = make({ dryRun: true });
    const d = guard.check(tx("0.001"));
    expect(d).toEqual({ ok: true, dryRun: true });
    for (let i = 0; i < 10; i++) guard.commit(tx("0.001"));
    expect(guard.check(tx("0.001")).ok).toBe(true);
  });
});
