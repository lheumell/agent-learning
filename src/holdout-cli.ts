import { parseFlags } from "./cli-utils.js";
import { recordLook, splitHoldout } from "./holdout.js";
import { loadCsvPrices } from "./simulate.js";
import { parseStrategyName, strategyFromFlags } from "./strategies.js";
import { evaluateSegment } from "./walkforward.js";

export const HOLDOUT_USAGE = `Usage : npm run holdout -- --csv fichier.csv [options]
  Évalue UNE stratégie, aux paramètres que vous avez déjà figés, sur la fin des données mise de côté.
  --pct 0.2              part finale réservée (même valeur que --holdout du walk-forward)
  --strategy sma|zrev    --fast 10 --slow 30   |   --window 50 --entry 2 --exit 0
  --fee 0.001  --slippage 0.0005
  Chaque regard est compté : ajuster ses choix après avoir vu ce résultat contamine la période.`;

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)} %`;

export interface HoldoutDeps {
  logPath?: string;
}

export function holdoutCommand(args: string[], log: (s: string) => void = console.log, deps: HoldoutDeps = {}) {
  if (args.includes("--help")) return log(HOLDOUT_USAGE);
  const f = parseFlags(args);
  if (!f.csv) throw new Error("--csv est obligatoire");
  const num = (k: string, d: number) => {
    const v = f[k] === undefined ? d : Number(f[k]);
    if (!Number.isFinite(v)) throw new Error(`--${k} doit être un nombre`);
    return v;
  };
  const p = num("pct", 0.2);
  const prices = loadCsvPrices(f.csv);
  const { holdout, cut } = splitHoldout(prices, p);
  const st = strategyFromFlags(parseStrategyName(f.strategy), num);
  const exec = { feeRate: num("fee", 0.001), slippageRate: num("slippage", 0.0005) };
  const looks = recordLook(deps.logPath ?? "data/holdout-log.json", `${f.csv}@${p}`);

  const r = evaluateSegment(prices, cut, prices.length, st.make, st.warmup, exec);
  log(
    [
      `Période réservée : ${holdout.length} barres (les ${(p * 100).toFixed(0)} % finaux de ${f.csv})`,
      `  ${st.make().name} : ${pct(r.returnPct)} · acheter-garder : ${pct(r.buyHoldPct)} · drawdown max ${r.maxDrawdownPct.toFixed(1)} % · ${r.trades} trade(s) · frais ${r.feesPaid.toFixed(2)} USD`,
      ``,
      looks === 1
        ? `  C'est votre 1er regard sur cette période. C'est le seul qui compte vraiment.`
        : `  ⚠ C'est votre ${looks}e regard sur cette période : si vous avez modifié vos choix après le précédent, ` +
          `elle n'est plus indépendante et ce résultat est optimiste.`,
    ].join("\n"),
  );
}
