import "dotenv/config";
import { parseEther } from "viem";
import { baseSepolia } from "viem/chains";
import { DEFAULT_AUDIT_PATH, DEFAULT_KILL_SWITCH_PATH, DEFAULT_STATE_PATH, type GuardConfig } from "./guard.js";

export function loadGuardConfig(): GuardConfig {
  return {
    allowedChainIds: [baseSepolia.id],
    maxPerTxWei: parseEther(process.env.MAX_PER_TX_ETH ?? "0.001"),
    maxPerDayWei: parseEther(process.env.MAX_PER_DAY_ETH ?? "0.005"),
    allowedRecipients: (process.env.ALLOWED_RECIPIENTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Sécurité par défaut : on simule sauf si DRY_RUN=false explicitement.
    dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
    killSwitchPath: DEFAULT_KILL_SWITCH_PATH,
    statePath: DEFAULT_STATE_PATH,
    auditPath: DEFAULT_AUDIT_PATH,
  };
}
