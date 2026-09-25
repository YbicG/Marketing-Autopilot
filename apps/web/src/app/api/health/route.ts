import type { HealthStatus } from "@mkt/contracts";

export const dynamic = "force-dynamic";

// Liveness only: Dokploy/Docker HEALTHCHECK hits this, so it must not depend on Postgres or Redis
// being up — otherwise a DB blip would make Traefik drop the whole app.
export function GET() {
  const body: HealthStatus = {
    ok: true,
    service: "web",
    version: process.env.GIT_SHA ?? "dev",
    checks: {},
  };
  return Response.json(body);
}
