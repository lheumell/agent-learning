import Anthropic from "@anthropic-ai/sdk";
import { AgentKit, walletActionProvider, type Action } from "@coinbase/agentkit";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { GuardedWalletProvider } from "./wallet.js";

const SYSTEM = `Tu es un agent d'apprentissage sur Base Sepolia (testnet, fonds sans valeur).
Tu disposes d'outils pour consulter et utiliser un wallet. Règles :
- Explique brièvement ce que tu fais avant chaque action.
- Un garde-fou en code limite les dépenses ; si une action est refusée, rapporte-le tel quel, ne cherche pas à contourner.
- Ne fais aucune transaction que l'utilisateur n'a pas demandée.`;

export async function buildActions(wallet: GuardedWalletProvider): Promise<Action[]> {
  const kit = await AgentKit.from({
    walletProvider: wallet,
    // Commencez petit : 2 actions (voir le solde, envoyer de l'ETH).
    // Pour ajouter des capacités (erc20, weth, pyth, defillama…), importez d'autres action providers.
    actionProviders: [walletActionProvider()],
  });
  return kit.getActions();
}

export async function runAgent(
  prompt: string,
  actions: Action[],
  opts: { model: string; maxTurns?: number; log?: (s: string) => void } = { model: "" },
) {
  const log = opts.log ?? console.log;
  const client = new Anthropic();
  const byName = new Map(actions.map((a) => [a.name, a]));
  const tools = actions.map((a) => ({
    name: a.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
    description: a.description,
    input_schema: zodToJsonSchema(a.schema as any, { $refStrategy: "none" }) as Anthropic.Tool.InputSchema,
  }));
  const toolToAction = new Map(actions.map((a) => [a.name.replace(/[^a-zA-Z0-9_-]/g, "_"), a]));

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  for (let turn = 0; turn < (opts.maxTurns ?? 8); turn++) {
    const res = await client.messages.create({
      model: opts.model,
      max_tokens: 1024,
      system: SYSTEM,
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) log(`\n🧠 ${block.text.trim()}`);
    }
    if (res.stop_reason !== "tool_use") return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const action = toolToAction.get(block.name) ?? byName.get(block.name);
      log(`\n🔧 ${block.name}(${JSON.stringify(block.input)})`);
      let out: string;
      let isError = false;
      try {
        if (!action) throw new Error(`outil inconnu : ${block.name}`);
        const args = action.schema.parse(block.input);
        out = await action.invoke(args);
      } catch (e) {
        out = e instanceof Error ? e.message : String(e);
        isError = true;
      }
      log(`   ↳ ${isError ? "❌" : "✅"} ${out.slice(0, 400)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: out, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
  log("\n⏹ Nombre maximum de tours atteint.");
}
