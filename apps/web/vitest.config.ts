import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom: nothing under src/lib touches the DOM, and that is the
    // point of the seam. If a test here ever needs a browser environment, the
    // logic it is testing has leaked into the UI.
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
