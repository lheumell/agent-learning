import { ViemWalletProvider } from "@coinbase/agentkit";
import { createWalletClient, http, type Hex, type TransactionRequest } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { Guard } from "./guard.js";

/**
 * Wallet AgentKit dont TOUTES les transactions passent par le Guard.
 * Comme les action providers (transfert, swap, ERC-20…) appellent tous
 * `walletProvider.sendTransaction`, le plafond s'applique à tous, y compris
 * ceux que vous ajouterez plus tard.
 *
 * Limite connue : `sign`, `signMessage` et `signTypedData` ne sont pas bloqués
 * (signer n'est pas dépenser, mais certains protocoles autorisent des paiements
 * via signature, comme x402 ou les permits ERC-20). N'ajoutez pas ces providers
 * sans étendre le Guard.
 */
export class GuardedWalletProvider extends ViemWalletProvider {
  constructor(
    walletClient: ConstructorParameters<typeof ViemWalletProvider>[0],
    private guard: Guard,
    private chainId: number,
  ) {
    super(walletClient);
  }

  override async sendTransaction(transaction: TransactionRequest): Promise<Hex> {
    const intent = {
      chainId: this.chainId,
      to: transaction.to ?? undefined,
      valueWei: BigInt((transaction.value as bigint | undefined) ?? 0n),
    };
    const decision = this.guard.check(intent);
    if (!decision.ok) {
      throw new Error(`GARDE-FOU : transaction refusée. ${decision.reason}`);
    }
    if (decision.dryRun) {
      this.guard.commit(intent);
      // Faux hash clairement identifiable : rien n'a été envoyé.
      return ("0x" + "dead".repeat(16)) as Hex;
    }
    const hash = await super.sendTransaction(transaction);
    this.guard.commit(intent, hash);
    return hash;
  }

  override async waitForTransactionReceipt(txHash: Hex) {
    if (txHash === "0x" + "dead".repeat(16)) {
      return { transactionHash: txHash, status: "success", simulated: true };
    }
    return super.waitForTransactionReceipt(txHash);
  }
}

export function createWallet(privateKey: Hex, rpcUrl: string, guard: Guard) {
  const account = privateKeyToAccount(privateKey);
  // La chain est fixée en dur sur Base Sepolia : impossible de viser le mainnet par configuration.
  const client = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  return new GuardedWalletProvider(client, guard, baseSepolia.id);
}
