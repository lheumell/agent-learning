import { parseFlags } from "./cli-utils.js";
import { DEFAULT_LEVERAGE, simulateLeveraged, summarize, type LeverageConfig, type PathResult, type Policy, type Summary } from "./leverage.js";
import { loadCsvPrices, syntheticPrices } from "./simulate.js";

export const RUIN_USAGE = `Usage : npm run ruin -- [options]
  Compare « petit gain + réinjection quand on approche de la liquidation » à « risque borné (stop prévu) »,
  avec des entrées SANS avantage, pour isoler l'effet de la structure de risque.
  --policy both|reinject|bounded   (défaut both)
  --wallet 10000     capital total        --stake 0.1    part engagée comme marge à l'ouverture
  --leverage 10      levier               --tp 0.01      prise de gain (+1 % de prix)
  --stop 0.05        (bounded) stop-loss en % de prix ; défaut : 0.5 / levier
  --trigger 0.03     (reinject) réinjecte à moins de 3 % de la liquidation   --fraction 1   part du capital libre injectée
  --hold 2000        durée max d'une position (barres)       --cooldown 5   attente entre deux positions
  --fee 0.0005       frais par côté                           --mmr 0.005    marge de maintenance
  Données : --seeds 300 --n 4000 --vol 0.007 --drift 0   (marche aléatoire simulée)
        ou  --csv fichier.csv [--n 4000] : fenêtres glissantes de n barres sur de vrais prix (elles se recouvrent)
  L'exposition notionnelle = stake x leverage x wallet : au-dessus de 1, la ruine totale devient possible malgré la réinjection.`;

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)} %`;

function paths(f: Record<string, string>, num: (k: string, d: number) => number): { series: number[][]; label: string } {
  const n = Math.floor(num("n", 4000));
  if (f.csv) {
    const all = loadCsvPrices(f.csv);
    if (all.length <= n) return { series: [all], label: `${f.csv} (1 fenêtre de ${all.length} barres)` };
    const step = Math.max(1, Math.floor(n / 4));
    const series: number[][] = [];
    for (let s = 0; s + n <= all.length; s += step) series.push(all.slice(s, s + n));
    return { series, label: `${f.csv} (${series.length} fenêtres de ${n} barres, qui se recouvrent : elles ne sont pas indépendantes)` };
  }
  const seeds = Math.max(1, Math.floor(num("seeds", 300)));
  const vol = num("vol", 0.007);
  const drift = num("drift", 0);
  return {
    series: Array.from({ length: seeds }, (_, i) => syntheticPrices({ n, seed: i + 1, vol, drift })),
    label: `${seeds} trajectoires simulées (marche aléatoire, n=${n}, vol=${vol}, drift=${drift})`,
  };
}

export function ruinCommand(args: string[], log: (s: string) => void = console.log) {
  if (args.includes("--help")) return log(RUIN_USAGE);
  const f = parseFlags(args);
  const num = (k: string, d: number) => {
    const v = f[k] === undefined ? d : Number(f[k]);
    if (!Number.isFinite(v)) throw new Error(`--${k} doit être un nombre`);
    return v;
  };
  const which = f.policy ?? "both";
  if (!["both", "reinject", "bounded"].includes(which)) throw new Error(`--policy : both | reinject | bounded (reçu "${which}")`);

  const base: LeverageConfig = {
    ...DEFAULT_LEVERAGE,
    walletUsd: num("wallet", DEFAULT_LEVERAGE.walletUsd),
    stakeFraction: num("stake", DEFAULT_LEVERAGE.stakeFraction),
    leverage: num("leverage", DEFAULT_LEVERAGE.leverage),
    takeProfitPct: num("tp", DEFAULT_LEVERAGE.takeProfitPct),
    feeRate: num("fee", DEFAULT_LEVERAGE.feeRate),
    maintenanceRate: num("mmr", DEFAULT_LEVERAGE.maintenanceRate),
    stopLossPct: f.stop === undefined ? undefined : num("stop", 0),
    reinjectTrigger: num("trigger", DEFAULT_LEVERAGE.reinjectTrigger),
    reinjectFraction: num("fraction", DEFAULT_LEVERAGE.reinjectFraction),
    maxHoldBars: num("hold", DEFAULT_LEVERAGE.maxHoldBars),
    cooldownBars: num("cooldown", DEFAULT_LEVERAGE.cooldownBars),
  };
  const { series, label } = paths(f, num);
  const exposure = base.stakeFraction * base.leverage;
  const policies: Policy[] = which === "both" ? ["reinject", "bounded"] : [which as Policy];

  const out: Record<string, Summary> = {};
  for (const policy of policies) {
    const rs: PathResult[] = series.map((p) => simulateLeveraged(p, { ...base, policy }));
    out[policy] = summarize(rs, base.walletUsd);
  }
  const holds = series.map((p) => (p[p.length - 1] / p[0] - 1) * 100);
  const holdSorted = [...holds].sort((a, b) => a - b);

  log(`${label}`);
  log(
    `Capital ${base.walletUsd} · marge initiale ${(base.stakeFraction * 100).toFixed(0)} % · levier ${base.leverage}× · ` +
      `exposition notionnelle ${(exposure * 100).toFixed(0)} % du capital · prise de gain ${(base.takeProfitPct * 100).toFixed(1)} %`,
  );
  if (exposure > 1) log(`⚠ Exposition > 100 % du capital : la perte totale est possible même en réinjectant tout.`);
  log("");
  const names: Record<string, string> = { reinject: "réinjecte à fond", bounded: "risque borné (stop)" };
  const header = "  " + "".padEnd(40) + policies.map((p) => names[p].padStart(22)).join("");
  log(header);
  const row = (label: string, g: (s: Summary) => string) =>
    log("  " + label.padEnd(40) + policies.map((p) => g(out[p]).padStart(22)).join(""));
  row("Positions gagnantes", (s) => (s.tradeWinRatePct === null ? "—" : `${s.tradeWinRatePct.toFixed(1)} %`));
  row("Capital final, médiane", (s) => pct(s.medianFinalPct));
  row("Capital final, moyenne", (s) => pct(s.meanFinalPct));
  row("Trajectoires terminées en gain", (s) => `${s.profitablePct.toFixed(0)} %`);
  row("Trajectoires avec perte ≥ 50 %", (s) => `${s.loss50Pct.toFixed(1)} %`);
  row("Trajectoires avec perte ≥ 90 %", (s) => `${s.loss90Pct.toFixed(1)} %`);
  row("Au moins une liquidation", (s) => `${s.liquidatedPct.toFixed(0)} %`);
  row("Pire baisse du patrimoine, médiane", (s) => `${s.medianMaxDrawdownPct.toFixed(1)} %`);
  row("Capital engagé dans la position, au pire (médiane)", (s) => `${s.medianPeakAtRiskPct.toFixed(0)} %`);
  row("Capital engagé dans la position, au pire (max)", (s) => `${s.worstPeakAtRiskPct.toFixed(0)} %`);
  row("Plus longue position, médiane (barres)", (s) => `${s.medianLongestHoldBars.toFixed(0)}`);
  row("Positions, médiane", (s) => `${s.medianTrades.toFixed(0)}`);
  row("Réinjections, moyenne", (s) => `${s.meanReinjections.toFixed(1)}`);
  log("");
  log(`  Référence : garder tout le capital en actif, sans levier : médiane ${pct(holdSorted[Math.floor(holdSorted.length / 2)])}`);
}
