import { defineConfig } from "vitest/config";

// Like core's: the launch job tests boot an in-process PGlite, which can take longer than the
// default 10 s hook timeout while core's suite runs alongside under turbo.
export default defineConfig({
  test: {
    maxWorkers: 2,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
