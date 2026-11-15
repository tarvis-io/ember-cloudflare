import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { testTimeout: 20_000, include: ["workshop-test/**/*.test.ts"] },
  plugins: [cloudflareTest({ wrangler: { configPath: "../../wrangler.workshop.jsonc" }, miniflare: { bindings: {
    SESSION_SECRET: "test-session-secret-not-for-production",
    TARVIS_CHAT_SECRET: "test-workshop-secret-at-least-32-characters",
    TARVIS_CLOUD_URL: "https://cloud.test",
    EMBER_MODELS_URL: "",
  } } })],
});
