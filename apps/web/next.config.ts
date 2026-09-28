import type { NextConfig } from "next";
import path from "node:path";

// Private app behind sign-in: never indexed, never framed by another site, no powerful features.
// The CSP carries only directives that can't break Next's inline bootstrap scripts; a nonce-based
// script-src is a separate change. frame-ancestors is 'self' (not 'none') so the sandboxed srcdoc
// email preview, which inherits this policy, still renders.
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  transpilePackages: ["@mkt/contracts", "@mkt/core", "@mkt/db", "@mkt/providers", "@mkt/video"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
