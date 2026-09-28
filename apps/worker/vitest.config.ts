import { defineConfig } from "vitest/config";

// The launch job tests boot an in-process PGlite (WASM Postgres). Each costs ~100 MB and a few
// seconds, so cap the worker count and give setup hooks room (same as packages/core).
export default defineConfig({
  test: {
    maxWorkers: 2,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
