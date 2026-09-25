import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  transpilePackages: ["@mkt/contracts", "@mkt/core", "@mkt/db", "@mkt/providers", "@mkt/video"],
};

export default config;
