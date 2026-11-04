export type Signal = "buy" | "sell" | "hold";

/** Une stratégie reçoit les prix un par un (jamais le futur) et rend un signal. */
export interface Strategy {
  readonly name: string;
  onPrice(price: number): Signal;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Croisement de moyennes mobiles simples (long uniquement).
 * - achat quand la moyenne rapide passe AU-DESSUS de la lente ;
 * - vente quand elle repasse EN DESSOUS.
 * Un croisement exige un état précédent : si la rapide est déjà au-dessus au premier
 * calcul possible, on ne déclenche rien (on attend le prochain vrai croisement).
 */
export class SmaCrossover implements Strategy {
  readonly name: string;
  private buf: number[] = [];
  private prevDiff: number | null = null;

  constructor(
    private fast = 10,
    private slow = 30,
  ) {
    if (!Number.isInteger(fast) || !Number.isInteger(slow) || fast < 1 || slow <= fast) {
      throw new Error(`fenêtres invalides : fast=${fast}, slow=${slow} (entiers, 1 <= fast < slow)`);
    }
    this.name = `SMA(${fast}/${slow})`;
  }

  onPrice(price: number): Signal {
    if (!Number.isFinite(price) || price <= 0) throw new Error(`prix invalide : ${price}`);
    this.buf.push(price);
    if (this.buf.length > this.slow) this.buf.shift();
    if (this.buf.length < this.slow) return "hold";

    const diff = mean(this.buf.slice(-this.fast)) - mean(this.buf);
    let signal: Signal = "hold";
    if (this.prevDiff !== null) {
      if (this.prevDiff <= 0 && diff > 0) signal = "buy";
      else if (this.prevDiff >= 0 && diff < 0) signal = "sell";
    }
    this.prevDiff = diff;
    return signal;
  }
}

/**
 * Retour à la moyenne (long uniquement), SANS état de position : le signal ne dépend que des
 * `window` derniers prix. Cela rend la reprise du mode papier (rejeu de l'historique) fiable.
 * - achat quand le z-score du prix passe sous -entryZ ;
 * - vente quand il remonte à exitZ ou plus.
 * Les signaux redondants (acheter déjà en position, vendre à plat) sont ignorés par le Portfolio.
 */
export class ZScoreReversion implements Strategy {
  readonly name: string;
  private buf: number[] = [];

  constructor(
    private window = 50,
    private entryZ = 2,
    private exitZ = 0,
  ) {
    if (!Number.isInteger(window) || window < 5) throw new Error(`window invalide : ${window} (entier >= 5)`);
    if (!(entryZ > 0)) throw new Error(`entryZ invalide : ${entryZ} (> 0)`);
    if (!(exitZ > -entryZ)) throw new Error(`exitZ invalide : ${exitZ} (doit être > -entryZ)`);
    this.name = `ZREV(${window}/${entryZ}/${exitZ})`;
  }

  onPrice(price: number): Signal {
    if (!Number.isFinite(price) || price <= 0) throw new Error(`prix invalide : ${price}`);
    this.buf.push(price);
    if (this.buf.length > this.window) this.buf.shift();
    if (this.buf.length < this.window) return "hold";
    const m = mean(this.buf);
    const sd = Math.sqrt(mean(this.buf.map((x) => (x - m) ** 2)));
    if (sd === 0) return "hold";
    const z = (price - m) / sd;
    if (z <= -this.entryZ) return "buy";
    if (z >= this.exitZ) return "sell";
    return "hold";
  }
}
