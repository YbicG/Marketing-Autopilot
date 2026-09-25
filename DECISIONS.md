# Decisions

The binding design decisions are D1–D27 in the implementation plan. This file records choices made while building.

## 2026-09-24 · Toolchain pins (M0)
- Node 24.18, pnpm 11.21 (the plan said pnpm 10; 11 is what's installed and works the same for workspaces).
- TypeScript `~6.0.3`, not 7.x: the TS 7 native port is days old and Next/eslint type tooling support is unproven.
- bullmq `5.x` + ioredis `5.x` (per plan; bullmq 6 / ioredis 6 exist but are not adopted yet).
- vitest `4.x`, better-auth `1.6.x`, drizzle-orm `0.45`, drizzle-kit `0.31` (per plan).
- Next `16.3`, React `19.3`, zod `4.6`, Tailwind `4.3`.
- Remotion: pinned to one exact version when the video package is added (M0 smoke test).

## 2026-09-24 · No local runtime
The laptop never runs the stack: no dev compose, no `next dev` against real services, no `pnpm setup`. Local verification is `pnpm check` (typecheck + unit tests + `next build`). DB-dependent tests use PGlite (in-process Postgres) so they still run locally. Everything else is verified on Dokploy after an auto-deploy from `main`.
