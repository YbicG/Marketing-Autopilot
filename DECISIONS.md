# Decisions

The binding design decisions are D1–D27 in the implementation plan. This file records choices made while building.

## 2026-09-24 · Toolchain pins (M0)
- Node 24.18, pnpm 11.21 (the plan said pnpm 10; 11 is what's installed and works the same for workspaces).
- TypeScript `~6.0.3`, not 7.x: the TS 7 native port is days old and Next/eslint type tooling support is unproven.
- bullmq `5.x` + ioredis `5.x` (per plan; bullmq 6 / ioredis 6 exist but are not adopted yet).
- vitest `4.x`, better-auth `1.6.x`, drizzle-orm `0.45`, drizzle-kit `0.31` (per plan).
- Next `16.3`, React `19.3`, zod `4.6`, Tailwind `4.3`.
- Remotion `4.0.528` exactly, for `remotion`, `@remotion/bundler` and `@remotion/renderer` (and every `@remotion/*` added later). Bump all together, never with `^`.

## 2026-09-24 · No local runtime
The laptop never runs the stack: no dev compose, no `next dev` against real services, no `pnpm setup`. Local verification is `pnpm check` (typecheck + unit tests + `next build`). DB-dependent tests use PGlite (in-process Postgres) so they still run locally. Everything else is verified on Dokploy after an auto-deploy from `main`.

## 2026-09-24 · Server smoke test
`pnpm --filter @mkt/worker smoke`, run in the worker container from the Dokploy terminal, checks vCPU/RAM, takes a Playwright screenshot of an inline page, and renders a 3 s 1080×1920 Remotion clip that ffprobe must read as h264/yuv420p/3 s. Remotion's Chrome Headless Shell is downloaded at image build (`ensure-browser`), and webpack's disk cache is off because node_modules is root-owned in the image.

## 2026-09-24 · Deleting a workspace
Settings → Delete everything removes the workspace row (every tenant table cascades) and revokes the user's sessions in one transaction. The GitHub user row stays, so signing in again starts a fresh, empty workspace. Files and third-party data join the delete as a background job once they exist (R2 and Upload-Post in M2, Resend in M4).

## 2026-09-24 · Lint = boundaries
`eslint.config.js` uses only the typescript-eslint parser, a handful of cheap correctness rules and `@typescript-eslint/no-restricted-imports` per package; the recommended preset was too noisy to be worth it. Enforced (§3.1): contracts imports only zod and its own files (tests may add vitest); `@anthropic-ai/sdk` only in `packages/core/src/ai/**`, with type-only imports allowed elsewhere in core; web never imports the Remotion renderer/bundler, the SDK, Playwright or `@mkt/video/render`; `@mkt/video` outside `src/render` never imports the renderer/bundler; `@mkt/db` never imports `@mkt/core`. Dynamic `import()` isn't covered. `pnpm check` now runs lint first.

## 2026-09-24 · Secret scan hook
`.githooks/pre-commit` runs `gitleaks protect --staged --redact` with `.gitleaks.toml` (default rules; `*.test.ts`, fixtures, the lockfile, migrations and `.env.example` allowlisted). If gitleaks isn't installed it prints a notice and lets the commit through. The root `prepare` script points `core.hooksPath` at `.githooks` only when run inside a git checkout, so Docker builds (no `.git`) are unaffected. The hook's executable bit has to be set in git (`git update-index --chmod=+x .githooks/pre-commit`) on the first commit.

## 2026-09-24 · Budget alert toast
The header shows the highest undismissed alert for this month (§7.1 step 7) under the spend meter: "You've used 80% of your $60 monthly limit.", or at 100% "You've hit your monthly limit. Paid steps are paused until you raise it.", with a Settings link and Dismiss. Dismiss (`POST /api/alerts/dismiss`, same-origin + session) clears every open alert for the workspace; the next threshold crossed raises a new one.

## 2026-09-24 · Model spike script
`pnpm --filter @mkt/worker spike` (in the worker container) lists models, then makes four tiny calls (effort low, max_tokens ≤ 512): Sonnet structured output with a `claudeFormat()` schema checked for banned keywords, Opus via `beta.messages` with `server-side-fallback-2026-07-01` + `fallbacks: "default"`, and Sonnet with one `web_search_20260209` search. It prints the served model, timings, usage and cost at the seed rates for comparison with the console before flipping `verified`. It lives in the worker, not `scripts/`, because the root can't resolve the SDK; it uses `anthropic()` from `@mkt/core/ai` so it stays inside the SDK boundary.

## 2026-09-24 · M1 ingest pipeline shape
One `ingest.run` job per "Read my product": repo + folder first (they can point at the website), then the website capture, notes, screenshot labels (Sonnet vision on a DPR-1 JPEG of the first screen, at most 12, 4 at a time), gap questions, research, then the profile. Every source step is a soft failure (`stage_warning`): a private repo or a dead link never ends the run; only "nothing readable at all", a budget stop or a refusal does. All M1 jobs stay on the `ingest` queue with one attempt (paid); M2 moves generation to `generate`. Captures don't yet share the `sem:heavy` semaphore (no renders exist until M3a).

## 2026-09-24 · Gap questions don't block
Questions are written and streamed as soon as the sources are read. Before the profile is written, the run waits up to 45 s for open questions, then goes ahead without them. Late answers are picked up by "Regenerate profile" (answers carry across runs as an INTERNAL evidence source).

## 2026-09-24 · Evidence bundle and source ids
`evidence.md` (stored at `ws/<id>/products/<id>/dna/<version>/evidence.md`) is built deterministically from one ingest run's artifacts, its research and all answers: public sources first, then internal, then third-party research, then screenshots. Source ids (S1…) are stable for the same rows. Unknown ids the model cites are dropped before they reach a source chip. Coverage = non-empty top-level fields with at least one real source ÷ non-empty fields.

## 2026-09-24 · Visibility rule for claims
A claim is `public_ok` only if one of its cited sources is the product's own public website/repo **and** that source's text supports it: a quote must appear verbatim, otherwise every number/price must appear and ≥70% of the content words. Internal docs and notes never make a claim public, even when the model cites the website for an internal-only fact (tested with a scorecard stat). Comparisons may rest on third-party research pages and expire after 30 days. Research is two calls: a tool loop (web search/fetch + `record_*` + `hn_search`) and a separate structured summary, since structured output is never combined with web search.

## 2026-09-24 · Strategy run
A separate `strategy` run (cap $1.50) is queued when the profile is written, so a slow Opus call never holds the ingest run open and each run has its own cap. The model's claim ids and screenshot ids are filtered to public claims and real assets; the launch date is the model's seasonal date if it's ≥14 days out, else the first Tuesday ≥14 days out (D21). Angle shares are 60/20/20.

## 2026-09-24 · GitHub without OAuth scopes
Public repos are read over unauthenticated REST through safe-fetch (optional `GITHUB_TOKEN` env for the rate limit). The sign-in token isn't used: the OAuth app only asks for `read:user user:email`. Private repos: drop the folder (M1) or a fine-grained token in the vault (M2).
