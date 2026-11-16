import { defineConfig, configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "tests/live/**"],
  },
});
