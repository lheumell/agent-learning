import "./no-telemetry.js";
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { backtestCommand } from "./backtest-cli.js";
import { dashboardCommand } from "./dashboard-cli.js";
import { entryCommand } from "./entry-cli.js";
import { DEFAULT_AUDIT_PATH } from "./guard.js";
import { historyCommand } from "./history-cli.js";
import { holdoutCommand } from "./holdout-cli.js";
import { paperCommand } from "./paper-cli.js";
import { ruinCommand } from "./ruin-cli.js";
import { CoinbaseSource, getCheckedPrice } from "./prices.js";
import { walkforwardCommand } from "./walkforward-cli.js";

const [cmd, ...rest] = process.argv.slice(2);

/**
 * Deux familles de commandes :
 *  - le CŒUR (prix, backtest, mode papier, tableau de bord…) : léger, démarre vite, ne détient aucune clé ;
 *  - l'AGENT (wallet, agent) : charge AgentKit, viem et le SDK Anthropic, uniquement à la demande.
 * Les paquets de l'agent sont des `optionalDependencies` : l'image Docker du trading ne les installe pas.
 */
async function loadAgentModules() {
  try {
    const [viemAccounts, agent, config, guard, wallet] = await Promise.all([
      import("viem/accounts"),
      import("./agent.js"),
      import("./config.js"),
      import("./guard.js"),
      import("./wallet.js"),
    ]);
    return { viemAccounts, agent, config, guard, wallet };
  } catch (e: any) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND") {
      throw new Error(
        "Les paquets de l'agent (AgentKit, viem, SDK Anthropic) ne sont pas installés. " +
          "Faites `npm ci` (sans --omit=optional). Détail : " + String(e.message).split("\n")[0],
      );
    }
    throw e;
  }
}

async function main() {
  if (cmd === "wallet") {
    const { viemAccounts } = await loadAgentModules();
    const key = process.env.AGENT_PRIVATE_KEY || viemAccounts.generatePrivateKey();
    const addr = viemAccounts.privateKeyToAccount(key as `0x${string}`).address;
    if (!process.env.AGENT_PRIVATE_KEY) {
      console.log("Nouvelle clé de TEST générée. Copiez-la dans .env :\n");
      console.log(`AGENT_PRIVATE_KEY=${key}\n`);
    }
    console.log(`Adresse : ${addr}`);
    console.log("Faucet Base Sepolia : https://portal.cdp.coinbase.com/products/faucet");
    return;
  }

  if (cmd === "dashboard") return void (await dashboardCommand(rest));
  if (cmd === "holdout") return holdoutCommand(rest);
  if (cmd === "history") return void (await historyCommand(rest));
  if (cmd === "walkforward") return walkforwardCommand(rest);
  if (cmd === "paper") return void (await paperCommand(rest));
  if (cmd === "backtest") return backtestCommand(rest);
  if (cmd === "ruin") return ruinCommand(rest);
  if (cmd === "entry") return entryCommand(rest);

  if (cmd === "price") {
    const symbol = rest[0] ?? "ETH";
    const q = await getCheckedPrice(new CoinbaseSource(), symbol);
    console.log(`${q.symbol}/USD = ${q.priceUsd.toFixed(2)} (±${q.confidenceUsd.toFixed(2)}) publié ${q.publishedAt.toISOString()} [${q.source}]`);
    return;
  }

  if (cmd === "audit") {
    console.log(existsSync(DEFAULT_AUDIT_PATH) ? readFileSync(DEFAULT_AUDIT_PATH, "utf8") : "(journal vide)");
    return;
  }

  if (cmd === "agent") {
    const prompt = rest.join(" ").trim();
    if (!prompt) throw new Error('Usage : npm run agent -- "ton instruction"');
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY manquante (.env)");
    if (!process.env.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY manquante : lancez `npm run wallet`");

    const m = await loadAgentModules();
    const cfg = m.config.loadGuardConfig();
    console.log(
      `Mode : ${cfg.dryRun ? "DRY RUN (simulation)" : "RÉEL sur testnet"} | ` +
        `max/tx ${cfg.maxPerTxWei} wei | max/jour ${cfg.maxPerDayWei} wei`,
    );
    const wallet = m.wallet.createWallet(
      process.env.AGENT_PRIVATE_KEY as `0x${string}`,
      process.env.RPC_URL ?? "https://sepolia.base.org",
      new m.guard.Guard(cfg),
    );
    const actions = await m.agent.buildActions(wallet);
    await m.agent.runAgent(prompt, actions, { model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5" });
    return;
  }

  console.log(
    "Commandes : npm run paper | npm run dashboard | npm run backtest | npm run ruin | npm run entry | npm run walkforward | npm run holdout | " +
      "npm run history | npm run price -- ETH | npm run wallet | npm run agent -- \"...\" | npm run audit",
  );
}

main().catch((e) => {
  console.error("Erreur :", e instanceof Error ? e.message : e);
  process.exit(1);
});
