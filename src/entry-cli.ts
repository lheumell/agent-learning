import { parseFlags } from "./cli-utils.js";
import { BreakoutRule, DipRule, RandomRule, type Sides } from "./entries.js";
import { splitHoldout, recordLook } from "./holdout.js";
import { DEFAULT_LEVERAGE, simulateLeveraged, summarize, type EntryRule, type LeverageConfig, type PathResult, type Policy, type Summary } from "./leverage.js";
import { loadPaths } from "./ruin-cli.js";
import { loadCsvPrices } from "./simulate.js";

export const ENTRY_USAGE = `Usage : npm run entry -- --rule dip|breakout [options]
  Teste une RÈGLE D'ENTRÉE avec une structure de sortie donnée, et la compare à des entrées AU HASARD de même
  fréquence et de mêmes sorties. Si elle ne fait pas mieux que le hasard, elle n'a pas d'avantage d'entrée.
  --rule dip         « j'achète après une baisse » : --lookback 48 --drop 0.04
  --rule breakout    « je suis la cassure d'un niveau » : --lookback 48
  --sides both|long  les deux sens (défaut) ou achat seulement
  Sorties et risque : --policy both|reinject|bounded  --tp 0.05  --stake 0.1  --leverage 5  --stop  --trigger  --fraction
                      --hold 2000  --cooldown 5  --fee 0.0005  --mmr 0.005  --wallet 10000
                      --financing 0.00002  coût de financement par barre (part du notionnel), d'après le barème de votre plateforme
  Données : --seeds 100 --n 4000 --vol 0.007 --drift 0 --model gbm|ou|mom (prix simulés ; mom : --phi 0.98 --trend 0.15)
        ou  --csv fichier.csv [--n 4000] (fenêtres glissantes de vrais prix, qui se recouvrent)
  Période réservée (CSV) : --holdout 0.2 (travailler sans les 20 % finaux) puis --final (les évaluer UNE fois)
  Régularité (CSV) : --blocks 4 découpe en 4 périodes consécutives sans recouvrement et évalue chacune séparément
  --random 30        tirages au hasard par trajectoire (200 s'il n'y a qu'une trajectoire)`;

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)} %`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface EntryEval {
  /** Percentile de la règle parmi les entrées au hasard, trajectoire par trajectoire. */
  beats: number[];
  rule: Summary;
  random: Summary;
  /** Percentile moyen de la règle parmi les entrées au hasard (50 = aucun avantage). */
  meanBeatPct: number;
  /** Part des trajectoires où la règle fait mieux que 95 % des tirages au hasard (au hasard : environ 5 %). */
  strongPct: number;
  /** Part des trajectoires où elle fait pire que 95 % des tirages au hasard. */
  weakPct: number;
  longs: number;
  shorts: number;
  entries: number;
}

/**
 * Compare une règle d'entrée à des entrées AU HASARD, avec les mêmes sorties, le même levier et, par trajectoire,
 * la même fréquence d'entrée (probabilité calibrée sur les signaux de la règle).
 */
export function evaluateRule(series: number[][], cfg: LeverageConfig, make: () => EntryRule, sides: Sides, K: number): EntryEval {
  const ruleRes: PathResult[] = [];
  const randRes: PathResult[] = [];
  const beats: number[] = [];
  series.forEach((p, pi) => {
    const r = simulateLeveraged(p, cfg, make());
    ruleRes.push(r);
    const prob = Math.min(0.5, Math.max(0.0005, r.signalsEligible / Math.max(1, r.eligibleBars)));
    let below = 0;
    for (let k = 0; k < K; k++) {
      const rr = simulateLeveraged(p, cfg, new RandomRule(prob, pi * 100003 + k + 1, sides));
      randRes.push(rr);
      if (rr.finalWallet < r.finalWallet) below++;
      else if (rr.finalWallet === r.finalWallet) below += 0.5;
    }
    beats.push((below / K) * 100);
  });
  return {
    beats,
    rule: summarize(ruleRes, cfg.walletUsd),
    random: summarize(randRes, cfg.walletUsd),
    meanBeatPct: beats.reduce((a, b) => a + b, 0) / beats.length,
    strongPct: (beats.filter((b) => b >= 95).length / beats.length) * 100,
    weakPct: (beats.filter((b) => b <= 5).length / beats.length) * 100,
    longs: median(ruleRes.map((r) => r.longs)),
    shorts: median(ruleRes.map((r) => r.shorts)),
    entries: median(ruleRes.map((r) => r.entries)),
  };
}

/** Découpe une série en N blocs consécutifs de même taille, sans recouvrement. */
export function splitBlocks(prices: number[], n: number, minBars = 500): number[][] {
  if (!Number.isInteger(n) || n < 2) throw new Error("--blocks doit être un entier >= 2");
  const size = Math.floor(prices.length / n);
  if (size < minBars) throw new Error(`blocs trop courts : ${size} barres (minimum ${minBars}). Réduisez --blocks ou utilisez plus de données.`);
  return Array.from({ length: n }, (_, i) => prices.slice(i * size, (i + 1) * size));
}

/** Variations extrêmes sur UNE barre : révèle les trous de données ou les krachs que le stop ne peut pas éviter. */
export function largeMoves(prices: number[], threshold = 0.08): { maxPct: number; count: number } {
  let max = 0;
  let count = 0;
  for (let i = 1; i < prices.length; i++) {
    const r = Math.abs(prices[i] / prices[i - 1] - 1);
    max = Math.max(max, r);
    if (r >= threshold) count++;
  }
  return { maxPct: max * 100, count };
}

export function entryCommand(args: string[], log: (s: string) => void = console.log, deps: { logPath?: string } = {}) {
  if (args.includes("--help")) return log(ENTRY_USAGE);
  const f = parseFlags(args, ["final"]);
  const num = (k: string, d: number) => {
    const v = f[k] === undefined ? d : Number(f[k]);
    if (!Number.isFinite(v)) throw new Error(`--${k} doit être un nombre`);
    return v;
  };
  if (f.rule !== "dip" && f.rule !== "breakout") throw new Error("--rule est obligatoire : dip | breakout");
  const sides = (f.sides ?? "both") as Sides;
  const lookback = num("lookback", 48);
  const drop = num("drop", 0.04);
  const make = (): EntryRule => (f.rule === "dip" ? new DipRule(lookback, drop, sides) : new BreakoutRule(lookback, sides));
  const ruleName = make().name; // valide aussi les paramètres tout de suite

  const which = f.policy ?? "both";
  if (!["both", "reinject", "bounded"].includes(which)) throw new Error(`--policy : both | reinject | bounded (reçu "${which}")`);
  const base: LeverageConfig = {
    ...DEFAULT_LEVERAGE,
    walletUsd: num("wallet", DEFAULT_LEVERAGE.walletUsd),
    stakeFraction: num("stake", 0.1),
    leverage: num("leverage", 5),
    takeProfitPct: num("tp", 0.05),
    feeRate: num("fee", DEFAULT_LEVERAGE.feeRate),
    maintenanceRate: num("mmr", DEFAULT_LEVERAGE.maintenanceRate),
    stopLossPct: f.stop === undefined ? undefined : num("stop", 0),
    reinjectTrigger: num("trigger", DEFAULT_LEVERAGE.reinjectTrigger),
    reinjectFraction: num("fraction", DEFAULT_LEVERAGE.reinjectFraction),
    financingRate: num("financing", 0),
    maxHoldBars: num("hold", DEFAULT_LEVERAGE.maxHoldBars),
    cooldownBars: num("cooldown", DEFAULT_LEVERAGE.cooldownBars),
  };
  const policies: Policy[] = which === "both" ? ["reinject", "bounded"] : [which as Policy];

  // --- données
  let series: number[][];
  let label: string;
  let note = "";
  let holdFrom = 0; // première barre réellement évaluée (hors échauffement)
  if (f.csv) {
    const holdout = f.holdout === undefined ? (f.final === "true" ? 0.2 : undefined) : num("holdout", 0.2);
    if (f.final === "true" && holdout === undefined) throw new Error("--final demande --holdout");
    if (holdout !== undefined) {
      const all = loadCsvPrices(f.csv);
      const sp = splitHoldout(all, holdout);
      if (f.final === "true") {
        const looks = recordLook(deps.logPath ?? "data/holdout-log.json", `${f.csv}@${holdout}#entry:${ruleName}`);
        const warm = Math.min(lookback, sp.cut);
        series = [all.slice(sp.cut - warm)];
        holdFrom = warm;
        label = `${f.csv}, PÉRIODE RÉSERVÉE (${sp.holdout.length} barres, avec ${warm} barres d'échauffement)`;
        note =
          looks === 1
            ? "C'est votre 1er regard sur la période réservée avec cette règle : c'est le seul qui compte."
            : `⚠ ${looks}e regard sur la période réservée avec cette règle : si vous avez ajusté vos choix entre-temps, elle n'est plus indépendante.`;
      } else {
        series = [sp.dev];
        label = `${f.csv}, partie développement (${sp.dev.length} barres ; ${sp.holdout.length} barres réservées, non utilisées)`;
      }
    } else if (f.blocks !== undefined) {
      series = [loadCsvPrices(f.csv)]; // --blocks découpe le fichier ENTIER, pas une fenêtre glissante
      label = `${f.csv}, fichier entier (${series[0].length} barres)`;
    } else {
      ({ series, label } = loadPaths(f, num));
    }
  } else {
    ({ series, label } = loadPaths(f, num));
  }
  let blocksMode = false;
  let dataNote = "";
  if (f.csv) {
    if (f.final === "true" && f.blocks !== undefined) throw new Error("--blocks et --final sont incompatibles");
    const all = series.flat();
    if (f.blocks !== undefined) {
      series = splitBlocks(series[0], num("blocks", 0));
      blocksMode = true;
      label += ` · ${series.length} blocs consécutifs de ${series[0].length} barres, sans recouvrement`;
    }
    if (f.final !== "true" && f.blocks === undefined && series.length === 1 || blocksMode) {
      const m = largeMoves(blocksMode ? all : series[0]);
      dataNote = `Données : plus forte variation sur une barre ±${m.maxPct.toFixed(1)} % ; ${m.count} barre(s) à ±8 % ou plus.` +
        (m.maxPct >= 10 ? " Un stop ne protège pas d'une variation de cette taille en une seule barre (trou de données ou krach)." : "");
    }
  } else if (f.blocks !== undefined) {
    throw new Error("--blocks s'applique aux fichiers CSV (--csv)");
  }
  const K = Math.max(5, Math.floor(num("random", series.length === 1 ? 200 : 30)));

  // --- simulation : règle contre hasard
  const out: Record<string, EntryEval> = {};
  for (const policy of policies) out[policy] = evaluateRule(series, { ...base, policy }, make, sides, K);

  log(`Règle ${ruleName} · ${label}`);
  log(
    `Capital ${base.walletUsd} · marge ${(base.stakeFraction * 100).toFixed(0)} % · levier ${base.leverage}× (exposition ${(base.stakeFraction * base.leverage * 100).toFixed(0)} %) · ` +
      `prise de gain ${(base.takeProfitPct * 100).toFixed(1)} % · ${K} tirages au hasard par trajectoire`,
  );
  if (series.length > 1 && f.csv && !blocksMode) log("⚠ Fenêtres de vrais prix qui se recouvrent : elles ne sont pas indépendantes, ne comptez pas les trajectoires comme autant de preuves.");
  if (dataNote) log(dataNote);
  for (const policy of policies) {
    const o = out[policy];
    log("");
    log(policy === "reinject" ? "— Sortie : on réinjecte à fond quand on approche de la liquidation —" : "— Sortie : risque borné, stop prévu à l'avance —");
    const head = "  " + "".padEnd(38) + "règle".padStart(12) + "au hasard".padStart(12);
    log(head);
    const row = (l: string, a: string, b: string) => log("  " + l.padEnd(38) + a.padStart(12) + b.padStart(12));
    row("Positions gagnantes", o.rule.tradeWinRatePct === null ? "—" : `${o.rule.tradeWinRatePct.toFixed(1)} %`, o.random.tradeWinRatePct === null ? "—" : `${o.random.tradeWinRatePct.toFixed(1)} %`);
    row("Capital final, médiane", pct(o.rule.medianFinalPct), pct(o.random.medianFinalPct));
    row("Capital final, moyenne", pct(o.rule.meanFinalPct), pct(o.random.meanFinalPct));
    row("Trajectoires avec perte ≥ 50 %", `${o.rule.loss50Pct.toFixed(1)} %`, `${o.random.loss50Pct.toFixed(1)} %`);
    row("Trajectoires avec perte ≥ 90 %", `${o.rule.loss90Pct.toFixed(1)} %`, `${o.random.loss90Pct.toFixed(1)} %`);
    row("Au moins une liquidation", `${o.rule.liquidatedPct.toFixed(0)} %`, `${o.random.liquidatedPct.toFixed(0)} %`);
    row("Positions, médiane", o.rule.medianTrades.toFixed(0), o.random.medianTrades.toFixed(0));
    log(`  La règle ouvre en médiane ${o.entries.toFixed(0)} positions (${o.longs.toFixed(0)} achats, ${o.shorts.toFixed(0)} ventes à découvert).`);
    log(
      series.length === 1
        ? `  La règle finit mieux que ${o.meanBeatPct.toFixed(0)} % des entrées au hasard (50 % = aucun avantage ; ≥ 95 % = signal ; une seule trajectoire : fragile).`
        : `  Percentile moyen de la règle parmi les entrées au hasard : ${o.meanBeatPct.toFixed(0)} % (50 % = aucun avantage). ` +
            `≥ 95 % sur ${o.strongPct.toFixed(0)} % des trajectoires, ≤ 5 % sur ${o.weakPct.toFixed(0)} % (au hasard : environ 5 % et 5 %).`,
    );
    if (series.length > 1 && series.length <= 12) {
      log(`  Percentile par ${blocksMode ? "bloc" : "trajectoire"} : ${o.beats.map((b) => b.toFixed(0) + " %").join(" · ")}`);
    }
  }
  // Références ABSOLUES : le « hasard » est une référence relative et, avec des coûts élevés, une référence perdante.
  // Une règle qui bat un hasard à −38 % n'est pas pour autant rentable : il faut aussi battre « ne rien faire » (0 %) et « garder ».
  const holds = series.map((p) => (p[p.length - 1] / p[holdFrom] - 1) * 100).sort((a, b) => a - b);
  log("");
  log(`  Références absolues, même période, sans levier : garder l'actif ${pct(holds[Math.floor(holds.length / 2)])} (médiane) · ne rien faire ${pct(0)}`);
  log("  Le « hasard » est une référence relative : avec des coûts élevés elle est perdante. Une règle doit aussi battre ces deux références, coûts déduits.");
  if (note) log("\n" + note);
}
