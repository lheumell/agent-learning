/**
 * AgentKit envoie des événements à https://cca-lite.coinbase.com (adresse du wallet,
 * réseau, nom des actions appelées) sans option de désactivation.
 * On bloque cet hôte exact : toute autre requête passe normalement.
 * À importer en tout premier.
 */
const BLOCKED_HOSTS = new Set(["cca-lite.coinbase.com"]);
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: any, init?: any) => {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (BLOCKED_HOSTS.has(url.hostname)) {
      return new Response(null, { status: 204 });
    }
  } catch {
    /* URL non analysable : on laisse passer */
  }
  return realFetch(input, init);
}) as typeof fetch;
