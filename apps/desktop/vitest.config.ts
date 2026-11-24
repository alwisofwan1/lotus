import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.tsx"],
    // LOT2-113: under load (tauri:dev building, other sessions testing) heavy jsdom tests ran past
    // the 5 s default and failed with "Test timed out in 5000ms", then passed alone. A limit only
    // matters to a test that is already failing or slow, so a passing run is not slowed by it.
    testTimeout: 20_000,
    globals: true,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "**/*.perf.spec.ts",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
