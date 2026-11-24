import { defineConfig } from "vitest/config";

export default defineConfig({
  css: {
    // Disable PostCSS processing — this is a pure Node.js project with no CSS.
    // Prevents vite from walking up to the parent Next.js postcss.config.mjs.
    postcss: {},
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "deploy/**/*.test.ts"],
  },
});
