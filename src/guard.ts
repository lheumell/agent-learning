import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Emplacements par défaut (sans dépendance lourde : `npm run audit` doit marcher sans les paquets de l'agent). */
export const DEFAULT_KILL_SWITCH_PATH = "data/STOP";
export const DEFAULT_STATE_PATH = "data/state.json";
export const DEFAULT_AUDIT_PATH = "data/audit.jsonl";

export interface GuardConfig {
  /** Chain IDs autorisés. Par défaut : Base Sepolia uniquement. */
  allowedChainIds: number[];
  maxPerTxWei: bigint;
  maxPerDayWei: bigint;
  /** Vide = toutes les adresses sont autorisées. */
  allowedRecipients: string[];
  dryRun: boolean;
  /** Si ce fichier existe, toute transaction est refusée (kill switch). */
  killSwitchPath: string;
  statePath: string;
  auditPath: string;
}

export interface TxIntent {
  chainId: number;
  to?: string;
  valueWei: bigint;
}

export type Decision =
  | { ok: true; dryRun: boolean }
  | { ok: false; reason: string };

interface State {
  day: string; // YYYY-MM-DD (UTC)
  spentWei: string;
}

/**
 * Garde-fou indépendant du LLM : les limites sont du code, pas des instructions.
 * Même si le modèle est manipulé (prompt injection), il ne peut pas les contourner.
 */
export class Guard {
  constructor(
    private cfg: GuardConfig,
    private now: () => Date = () => new Date(),
  ) {}

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private loadState(): State {
    if (existsSync(this.cfg.statePath)) {
      const s = JSON.parse(readFileSync(this.cfg.statePath, "utf8")) as State;
      if (s.day === this.today()) return s;
    }
    return { day: this.today(), spentWei: "0" };
  }

  private saveState(s: State) {
    mkdirSync(dirname(this.cfg.statePath), { recursive: true });
    writeFileSync(this.cfg.statePath, JSON.stringify(s));
  }

  private audit(entry: Record<string, unknown>) {
    mkdirSync(dirname(this.cfg.auditPath), { recursive: true });
    appendFileSync(
      this.cfg.auditPath,
      JSON.stringify({ t: this.now().toISOString(), ...entry }) + "\n",
    );
  }

  /** Vérifie une transaction. Ne dépense rien tant que `commit` n'est pas appelé. */
  check(tx: TxIntent): Decision {
    const deny = (reason: string): Decision => {
      this.audit({ event: "denied", reason, to: tx.to, valueWei: tx.valueWei.toString() });
      return { ok: false, reason };
    };

    if (existsSync(this.cfg.killSwitchPath)) {
      return deny(`kill switch actif (${this.cfg.killSwitchPath})`);
    }
    if (!this.cfg.allowedChainIds.includes(tx.chainId)) {
      return deny(`chain ${tx.chainId} non autorisée`);
    }
    if (tx.valueWei < 0n) return deny("montant négatif");
    if (tx.valueWei > this.cfg.maxPerTxWei) {
      return deny(`montant ${tx.valueWei} wei > plafond par transaction ${this.cfg.maxPerTxWei}`);
    }
    if (this.cfg.allowedRecipients.length > 0) {
      const to = tx.to?.toLowerCase();
      const allowed = this.cfg.allowedRecipients.map((a) => a.toLowerCase());
      if (!to || !allowed.includes(to)) {
        return deny(`destinataire ${tx.to ?? "(création de contrat)"} hors liste blanche`);
      }
    }
    const spent = BigInt(this.loadState().spentWei);
    if (spent + tx.valueWei > this.cfg.maxPerDayWei) {
      return deny(
        `plafond journalier dépassé (déjà ${spent} wei, demandé ${tx.valueWei}, max ${this.cfg.maxPerDayWei})`,
      );
    }
    return { ok: true, dryRun: this.cfg.dryRun };
  }

  /** À appeler après une transaction réellement envoyée (ou simulée) pour comptabiliser. */
  commit(tx: TxIntent, txHash?: string) {
    if (!this.cfg.dryRun) {
      const s = this.loadState();
      s.spentWei = (BigInt(s.spentWei) + tx.valueWei).toString();
      this.saveState(s);
    }
    this.audit({
      event: this.cfg.dryRun ? "simulated" : "sent",
      to: tx.to,
      valueWei: tx.valueWei.toString(),
      txHash,
    });
  }
}
