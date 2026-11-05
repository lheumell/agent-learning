import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readPaperState, summarizeState } from "./paper.js";
import { buyAndHoldEquity } from "./portfolio.js";
import { renderPage } from "./dashboard-page.js";

const SYMBOL_RE = /^[A-Z0-9]{2,10}$/;
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024;
const MAX_POINTS = 600;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface DashboardOptions {
  dataDir: string;
}

/** Lit les lignes JSON d'un fichier .jsonl. Si le fichier est gros, ne lit que la fin. Ignore les lignes invalides. */
export function readJsonl(path: string, maxBytes = MAX_JOURNAL_BYTES): Record<string, any>[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let text = buf.toString("utf8");
    if (size > maxBytes) text = text.slice(text.indexOf("\n") + 1); // première ligne probablement coupée
    const out: Record<string, any>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* ligne partielle ou corrompue : ignorée */
      }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (max - 1))]);
  return out;
}

export function listSymbols(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .map((f) => /^paper-([A-Z0-9]{2,10})\.json$/.exec(f)?.[1])
    .filter((s): s is string => !!s)
    .sort();
}

export function paperPayload(dataDir: string, symbol: string) {
  const state = readPaperState(join(dataDir, `paper-${symbol}.json`));
  const events = readJsonl(join(dataDir, `paper-${symbol}.jsonl`));
  const ticks = events.filter((e) => e.event === "tick");
  const series = downsample(
    ticks.map((e) => ({
      t: e.t as string,
      price: e.price as number,
      equity: e.equity as number,
      buyHold:
        state.startPrice === null ? null : buyAndHoldEquity(state.startPrice, e.price as number, state.exec),
    })),
    MAX_POINTS,
  );
  return {
    status: summarizeState(state),
    exec: state.exec,
    lastTickAt: ticks.length ? (ticks[ticks.length - 1].t as string) : null,
    series,
    trades: events.filter((e) => e.event === "trade").slice(-50).reverse(),
    skipped: events.filter((e) => e.event === "skipped").slice(-10).reverse().map((e) => ({ t: e.t, reason: String(e.reason) })),
  };
}

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  });
  res.end(body);
}
const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

function hostAllowed(req: IncomingMessage): boolean {
  const h = (req.headers.host ?? "").toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return LOOPBACK_HOSTS.has(name);
}

/**
 * Serveur local en LECTURE SEULE : il n'écrit rien, ne lance rien, ne touche pas au wallet.
 * - GET/HEAD uniquement ;
 * - l'en-tête Host doit être local (contre le « DNS rebinding » : un site web qui ferait pointer
 *   son nom vers 127.0.0.1 pour lire vos données) ;
 * - aucun chemin ne vient de l'utilisateur : le symbole est validé puis inséré dans un gabarit fixe ;
 * - CSP stricte avec nonce, la page n'insère jamais de données via innerHTML.
 */
export function createDashboardServer(opts: DashboardOptions): Server {
  return createServer((req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "méthode non autorisée" });
      if (!hostAllowed(req)) return json(res, 403, { error: "hôte non autorisé" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/healthz") return json(res, 200, { ok: true });

      if (path === "/") {
        const nonce = randomBytes(16).toString("base64");
        return send(res, 200, renderPage(nonce), "text/html; charset=utf-8", {
          "Content-Security-Policy":
            `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; ` +
            `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
      }

      if (path === "/api/symbols") return json(res, 200, { symbols: listSymbols(opts.dataDir) });

      const m = /^\/api\/paper\/([^/]+)$/.exec(path);
      if (m) {
        const symbol = decodeURIComponent(m[1]).toUpperCase();
        if (!SYMBOL_RE.test(symbol)) return json(res, 400, { error: "symbole invalide" });
        if (!existsSync(join(opts.dataDir, `paper-${symbol}.json`))) {
          return json(res, 404, { error: `aucune donnée pour ${symbol} (lancez : npm run paper -- --symbol ${symbol})` });
        }
        return json(res, 200, paperPayload(opts.dataDir, symbol));
      }

      if (path === "/api/guard") {
        const rows = readJsonl(join(opts.dataDir, "audit.jsonl")).slice(-50).reverse();
        return json(res, 200, { rows });
      }

      return json(res, 404, { error: "introuvable" });
    } catch (e) {
      // Message court, jamais de trace d'appel ni de chemin système dans la réponse.
      const msg = e instanceof Error ? e.message.replace(/\/[^\s]+/g, "<chemin>") : "erreur";
      return json(res, 500, { error: msg });
    }
  });
}
