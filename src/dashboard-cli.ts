import { parseFlags } from "./cli-utils.js";
import { createDashboardServer } from "./dashboard.js";

export const DASHBOARD_USAGE = `Usage : npm run dashboard -- [options]
  --port 8787      port d'écoute (défaut 8787)
  --data data      dossier des données du mode papier (défaut data)
  --expose         écoute sur toutes les interfaces (utile dans Docker). ⚠ AUCUNE authentification :
                   ne l'exposez jamais sur un réseau non fiable.
Le tableau de bord est en lecture seule.`;

export async function dashboardCommand(args: string[], log: (s: string) => void = console.log) {
  if (args.includes("--help")) return log(DASHBOARD_USAGE);
  const f = parseFlags(args, ["expose"]);
  const port = Number(f.port ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port doit être un entier entre 1 et 65535");
  const expose = f.expose === "true";
  const host = expose ? "0.0.0.0" : "127.0.0.1";
  const server = createDashboardServer({ dataDir: f.data ?? "data" });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  log(`Tableau de bord : http://localhost:${port}  (lecture seule${expose ? ", écoute sur toutes les interfaces" : ", local uniquement"})`);
  if (expose) log("⚠ --expose : aucune authentification. Limitez l'accès (ex. Docker : publier sur 127.0.0.1 uniquement).");

  const stop = () => {
    log("\nArrêt du tableau de bord.");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
