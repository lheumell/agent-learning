import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("dépendances de l'image Docker", () => {
  const root = json("package.json");
  const img = json("docker/package.json");
  const lock = json("docker/package-lock.json");

  it("ne contiennent que tsx et dotenv, aux mêmes versions que le projet", () => {
    expect(Object.keys(img.dependencies).sort()).toEqual(["dotenv", "tsx"]);
    expect(img.dependencies.tsx).toBe(root.dependencies.tsx);
    expect(img.dependencies.dotenv).toBe(root.dependencies.dotenv);
    expect(img.devDependencies).toBeUndefined();
    expect(img.optionalDependencies).toBeUndefined();
  });
  it("sont en modules ES comme le projet (sinon tsx ne lit pas les .ts comme prévu)", () => {
    expect(img.type).toBe("module");
    expect(root.type).toBe("module");
  });
  it("ont un verrou cohérent avec docker/package.json", () => {
    expect(lock.packages[""].dependencies).toEqual(img.dependencies);
  });
  it("le cœur n'importe aucun paquet absent de l'image", () => {
    // Fichiers chargés par les commandes du cœur : aucun import de paquet autre que dotenv/tsx/node:*.
    const core = ["index", "no-telemetry", "backtest-cli", "dashboard-cli", "dashboard", "dashboard-page", "history-cli", "history", "holdout-cli", "holdout", "paper-cli", "paper", "prices", "walkforward-cli", "walkforward", "strategies", "strategy", "portfolio", "simulate", "backtest", "cli-utils", "guard", "leverage", "ruin-cli", "entries", "entry-cli", "regimes"];
    const bare = /from\s+["']([^."'][^"']*)["']|import\s+["']([^."'][^"']*)["']/g;
    for (const f of core) {
      const src = readFileSync(`src/${f}.ts`, "utf8");
      for (const m of src.matchAll(bare)) {
        const mod = (m[1] ?? m[2]).replace(/^node:/, "node:");
        expect(["dotenv/config"].includes(mod) || mod.startsWith("node:"), `src/${f}.ts importe « ${mod} », absent de l'image`).toBe(true);
      }
    }
  });
  it("le Dockerfile utilise ce verrou et pas celui du projet", () => {
    const df = readFileSync("Dockerfile", "utf8");
    expect(df).toMatch(/COPY docker\/package\.json docker\/package-lock\.json/);
    expect(df).not.toMatch(/COPY package-lock\.json|COPY package\.json package-lock\.json/);
    expect(df).toMatch(/npm ci --omit=dev/);
  });
});
