import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bloque la télémétrie d'AgentKit pour tous les tests (local et CI).
    setupFiles: ["./tests/setup.ts"],
  },
});
