import "./no-telemetry.js";
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { buildActions, runAgent } from "./agent.js";
import { loadGuardConfig } from "./config.js";
import { Guard } from "./guard.js";
import { createWallet } from "./wallet.js";

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  if (cmd === "wallet") {
    const key = process.env.AGENT_PRIVATE_KEY || generatePrivateKey();
    const addr = privateKeyToAccount(key as Hex).address;
    if (!process.env.AGENT_PRIVATE_KEY) {
      console.log("Nouvelle clé de TEST générée. Copiez-la dans .env :\n");
      console.log(`AGENT_PRIVATE_KEY=${key}\n`);
    }
    console.log(`Adresse : ${addr}`);
    console.log("Faucet Base Sepolia : https://portal.cdp.coinbase.com/products/faucet");
    return;
  }

  if (cmd === "audit") {
    const p = loadGuardConfig().auditPath;
    console.log(existsSync(p) ? readFileSync(p, "utf8") : "(journal vide)");
    return;
  }

  if (cmd === "agent") {
    const prompt = rest.join(" ").trim();
    if (!prompt) throw new Error('Usage : npm run agent -- "ton instruction"');
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY manquante (.env)");
    if (!process.env.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY manquante : lancez `npm run wallet`");

    const cfg = loadGuardConfig();
    console.log(
      `Mode : ${cfg.dryRun ? "DRY RUN (simulation)" : "RÉEL sur testnet"} | ` +
        `max/tx ${cfg.maxPerTxWei} wei | max/jour ${cfg.maxPerDayWei} wei`,
    );
    const wallet = createWallet(
      process.env.AGENT_PRIVATE_KEY as Hex,
      process.env.RPC_URL ?? "https://sepolia.base.org",
      new Guard(cfg),
    );
    const actions = await buildActions(wallet);
    await runAgent(prompt, actions, { model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5" });
    return;
  }

  console.log("Commandes : npm run wallet | npm run agent -- \"...\" | npm run audit");
}

main().catch((e) => {
  console.error("Erreur :", e instanceof Error ? e.message : e);
  process.exit(1);
});
