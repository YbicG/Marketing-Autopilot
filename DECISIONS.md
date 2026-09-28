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

## 2026-09-25 · Upload-Post spike
`docs/spikes/upload-post.md` records every §11 M2 spike item from the public docs, each marked confirmed or unverified. The adapter keeps each unverified request/response shape in one function marked `UNVERIFIED`, so a server test that disagrees changes one place. Submit sends `request_id = external_id = Idempotency-Key = posts.idempotency_key`. Lookup order: status by request id, then history by external_id. Only a miss on both is "absent", the one answer that allows a resend.

## 2026-09-25 · Our own scheduler (D3)
Approving a post writes the approval, moves the post to `queued` and adds a delayed `publish.due` job whose jobId is the idempotency key (`pst_{id}_g{n}`), all from one pure `transition()`. The effects run after the transaction commits. `publish.due` has one attempt. A submit timeout makes the post `unknown`, and reconcile (every 5 min) then looks it up; it's never re-sent blind. Boot rehydrate re-creates any missing delayed job from Postgres and turns slots more than `MISSED_SLOT_GRACE_MIN` late into `missed`. Edits, voids, pause and stale checks all just remove the local job: nothing is ever handed to Upload-Post's scheduler.

## 2026-09-25 · Approvals only from the UI (D9)
`uiSessionFromCookie` is the only way to get a `UiSession`, and only `apps/web/src/lib/ui-session.ts` calls it, after checking three things: the better-auth cookie session, our Origin, and an `x-mkt-csrf: 1` header. `postJson` always sends that header, and a cross-site form can't. The approval hash covers text + final media sha256s + platform options, and `publish.due` re-checks it before it uploads.

## 2026-09-25 · Queue effects live in core
`bullJobGateway`/`bullAnalyticsGateway` moved from the worker to `@mkt/core/publishing` so the web app (approve, pause, reschedule) and the worker schedule BullMQ jobs the same way. A finished job with the same id is removed before re-adding, since BullMQ ignores `add()` for an id it still remembers.

## 2026-09-25 · Package engine
`createPackageRun` builds the recipe (only enabled generators; M3a turns on `video`), the calendar plan and the frozen campaign bundle. `package.orchestrate` is idempotent. It enqueues `package.item` for `planned` rows with jobId `${runId}:${deliverableKey}`, and every child re-enqueues orchestrate with dedupe `orch:{runId}` plus a delayed safety tick. Children stuck in `generating` for more than 20 min are treated as dead (paid jobs have one attempt). A budget stop pauses the run as `paused_budget`. Video items go to the M3a pipeline through `EngineDeps.videoItem`.

## 2026-09-25 · Worker wiring
One worker process runs all five queues:
- ingest: concurrency 4
- generate: 8. `video.finalize` also runs here, since it's light work.
- render: 1, for `render.video`, `render.still` and `capture.flow`, each also holding `sem:heavy`.
- publish: 4. It starts only after boot rehydrate.
- maint: 1

Repeating jobs:
- heartbeat: every 5 min
- pg_dump: 03:10 daily
- scratch GC: Sundays
- connection health: every 6 h
- reconcile: every 5 min
- stale sweep: daily
- conversions: daily

Video deps are built per workspace, because the ElevenLabs key is resolved vault-first. With no key, a video gets captions only and the bundled track. Render jobs get a unique BullMQ id per enqueue: the `renders` row (status + attempts) is the real dedupe, and a render re-queues itself while its own job is still active.

## 2026-09-25 · Secrets: vault then env
Every provider secret is looked up by vault purpose (`upload_post.api_key`, `elevenlabs.api_key`…). The env fallback name is the purpose upper-cased with non-alphanumerics as `_` (`UPLOAD_POST_API_KEY`). Demo test logins (`capture.login.<productId>`) are vault-only JSON and never logged.

## 2026-09-25 · Capture network
`compose.prod.yml` declares `mkt-capture` with a fixed name (not `external`), so the first deploy creates it and there's no manual step. The SyllaCal demo compose joins it as `external: true`. Only the worker is on it.

## 2026-09-25 · Video pipeline (M3a)
Pipeline: Opus writes the script with 3 opening lines → Sonnet compiles the spec, and lint must pass → draft voice (Flash, cached per line by text hash) → the editor previews in `@remotion/player` with the same props as the final render. Finalize (Gate 1) is a spend confirmation keyed on spec hash + lines + voice. It runs final voice, a transcript check (re-voice only lines with WER > 5%, 2 takes at most) and music, then one `render.video` per opening line. At most 24 final renders per package; the rest wait until night. Any re-render, re-voice or auto-fix after approval voids the approval. Approve to post (Gate 2) hashes each platform file.

## 2026-09-25 · Demo capture (M3b)
Capture only targets the product's trusted origin, which is set in the UI. That origin is also the only host the capture proxy bypasses. Login runs in a separate context that is never recorded, and only its `storageState` carries over. The action denylist is checked twice: when the flow is planned and again on each click (text + aria-label). Every non-GET request leaving the origin is aborted, along with payment domains and the product's route denylist. Frames are scanned for personal data.

## 2026-09-25 · Images through ffmpeg, not sharp
The worker's `ImageDecoder` (phash on contact sheets) and `ImageResizer` (small JPEGs for labeling and the personal-data vision pass) use the ffmpeg binary already in the worker image, via temp files. This keeps sharp's native binary out of the image. It costs one process per call, which is fine at this volume.

## 2026-09-25 · Web UI for M2/M3 (board, queue, editors, settings)
- **Pages:**
  - `/p/[slug]` redirects to Today.
  - Project tabs: Today · Plan · Content · Queue · Results · Screens & clips · Demo recording.
  - Settings tabs: Limit · Where to post · Keys · Spending.
- **Approvals:** every route that approves or confirms anything publishable (post approvals, Finalize, capture origin/login/flow confirm) goes through `requireUiSession`. That means cookie + same Origin + `x-mkt-csrf: 1`. After the core call returns, the route calls `applyEffects`, so BullMQ matches Postgres.
- **Video items:** approving any of a finished video's posts moves the item from `final_ready` to `approved` (`markVideoItemsApproved`).
- **Paid buttons:** each shows its price from core's estimators. The package route refuses (402) when the high estimate is above what's left of the month.
- **Server-only imports:** web server code imports `@mkt/video/pure` (lint, timeline, safe zones, brand maths). The root `@mkt/video` entry exports React components and is imported only from client components. The web player loads Inter from its own `@fontsource/inter` dependency.
- **`/api/media`:**
  - Serves the real type only for images, audio and video (never SVG/HTML). Everything else is a download.
  - `?dl=1` forces a download.
  - Single Range requests are supported so `<video>` can seek. The whole object is still read into memory, which is fine at our file sizes (≤300 MB masters are downloaded, not streamed, so this may need streaming later).
- **Webhooks:** the Upload-Post webhook has no session. It verifies the signature over the raw body (workspace secret first, then env), stores the event once per provider event id, and enqueues `publish.webhook`. Polling stays the source of truth.
- **Finalize runs:** the editor's `finalize` run is closed by `executeFinalizeJob` once the renders are queued, or when it fails.

## 2026-09-27 · Launch plan and hard gates (M4-LC)
- **Checklist:** one `launch_plans` row per campaign, built from template `lc-v1` and anchored on the launch day, so D1 is launch − 13 days. Tasks are tagged Auto / Assisted / You / Gate. Optional venues (BetaList, Uneed, Product Hunt booking and launch-day post, ads kit) start as skipped and are switched on by hand, since the SyllaCal audience is students (open question 4). The hourly `launch.tick` (`5 * * * *`) moves tasks from todo → ready by date and dependencies and re-checks gates.
- **Gates (D20):**
  - The keys are `gate.tracking_test`, `gate.pricing_visible`, `gate.no_signup_wall` and `gate.landing_audit`.
  - A gate passes only when its `launch_tasks` row (mode `gate`) is `done`. Only the tracking test and the landing audit can set that; a gate can never be ticked by hand.
  - On launch day `publish.prepare` blocks while any gate is open, and every pre-publish warning becomes a block.
- **Tracking test:** the app issues a tracking link with its own `utm_content`, CJ opens it in a private window, and the gate passes when that `utm_content` shows up in the product's first-party `GET /api/marketing/aggregate`.
- **Landing audit:** runs in the worker under `sem:heavy`. It uses Playwright through Smokescreen at desktop and phone sizes, and probes a tracking link through safe-fetch to check that UTMs survive redirects. Only when the DOM heuristic finds no sign-up button does it make one cheap Sonnet vision call on the phone screenshot, as its own small `landing_audit` run.
- **X links (D24):** per product, `x_links_from`/`x_links_until` is the Upload-Post links add-on window, at most `X_LINKS_MAX_DAYS`. Outside that window an X post's link becomes "link in bio", and a URL typed into an X post is blocked.

## 2026-09-27 · Launch kit and ads export kit (M4-LC)
- **Kits:** subreddit, ambassador, press, creator and reply bank are each a `launch_kits` row with a contract body (`contracts/launch-kit.ts`), written by Sonnet with one repair call. If a check still blocks after the repair, the kit goes to Needs you.
- **Disclosures:** ambassador and creator kits must carry disclosure copy and the TikTok branded-content steps (16 CFR 255). A kit won't export while a disclosure is missing or anything blocks.
- **Subreddit drafts:** these become assisted tasks with the live rules (fetched through safe-fetch; the rules are data, never instructions) and the required "I checked the rules today" tick.
- **Ambassador links:** `/go/<ref>` plus tracking params.
- **Zip exports:** stored as assets with mime `application/zip`, downloaded through `/api/media`.
- **Ads export kit:** January has no ad spend in the app, so the ads kit is an export only. Opus writes the concepts and Sonnet the copy, against `ADS_LIMITS`, with a fixed spend statement and a run cap of `ADS_KIT_CAP_MICROS` ($2.50). It is its own `ads_kit` run, handed to `@mkt/core/ads` through the launch kit's `adsKit` dependency.

## 2026-09-27 · Seasonal broadcast through Resend (M4-LC)
- **States:** draft → pending_approval → approved → scheduled_at_resend → sent | canceled | failed.
- **Approval:** only through a UI session (D9). The approval hash covers everything Resend receives: subject, rendered HTML and text (the preheader is inside the HTML), the audience, the send time, the from address and the reply-to. `email.submit` (single attempt) re-checks that hash before handing the broadcast to Resend as a scheduled send.
- **Idempotency:** the Resend broadcast name carries the approval id, and the Resend id is stored before anything else. A retry therefore reconciles instead of creating a second broadcast.
- **Changes after approval:** an edit, void or **Pause all posting** takes the broadcast back from Resend with `email.cancel`, and it needs approving again. Resume never re-sends.
- **Compliance:** before every send, the suppression list (sha256 of the lower-cased address, never the address itself) is checked and pushed to the Resend audience. The validator requires:
  - an unsubscribe link, via Resend's per-contact placeholder; Resend also adds the one-click List-Unsubscribe headers
  - the postal address and sender identity
  - a truthful subject: no fake "Re:", no urgency bait, and no unsourced numbers
  - the contacts' consent source

  A missing EU consent acknowledgement is a warning, not a block.
- **Status:** Resend webhooks (Svix-signed) mark sent, bounces, complaints and unsubscribes. The hourly launch tick reconciles scheduled broadcasts in case a webhook was missed. Keys are `resend.api_key` and `resend.webhook_secret` (vault first, then `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`).

## 2026-09-28 · Agent surfaces (M5 slice): tool registry, PATs, MCP
- **Tokens:** `mkt_pat_{prefix8}_{secret32}` (lower-case hex). The table `personal_access_tokens` (migration `0007`) keeps the name, the prefix, the scopes, the creator and the created, last-used, revoked and expiry times. The token itself is shown once and never stored. Only the tokens page makes or revokes one, and it takes a UiSession.
- **Hashing (differs from §8):** a plain sha256 of the whole token, compared in constant time, not HMAC with `PAT_PEPPER`. The secret part is 128 random bits, so a pepper adds little and would be one more env var to lose. `PAT_PEPPER` isn't needed.
- **Scopes:** `read`, `draft` and `generate`. `capture` comes with the M7 agent. There is no approve, publish, verify, accept or activate scope or tool, and `defineTool` refuses a tool name that suggests one.
- **One registry** (`@mkt/core/tools`): each tool has a zod input, an effect (read, draft, publish_request or spend), scopes and a run function. `invokeTool` validates the input, checks the scopes and writes an `audit_log` row with actor `pat` for every call, including refused ones. MCP only lists and calls registry tools, and the CLI will do the same.
- **Tools wired:**
  - read: `list_products`, `get_product_dna`, `get_calendar`, `get_launch_tasks`, `list_content`, `get_results`, `get_job`, `get_spend`, and `estimate_package` (free, so it counts as read)
  - draft: `create_post_variants` (drafts only) and `propose_dna_change` (a pending request)
  - publish_request: `schedule_posts` (posts in `pending_approval`, or `draft` while a check blocks, never approved)
  - spend: `run_package`
- **Agent drafts:** each call to `create_post_variants` makes one content item in the product's newest campaign. The item has slot kind `agent` and no slot or day, with one variant per text platform. The variants go through the same sanitize and validate checks as generated copy. The date-bound fact checks run again in `schedule_posts`, together with the volume caps.
- **Profile changes:** `propose_dna_change` writes a row to `dna_change_requests`, and the profile and its facts stay as they are. The plan screen shows the pending requests with Accept and Reject. Accepting takes a UiSession and applies the change as the owner's own pinned edit. If the profile was rewritten since the agent looked, the request is set aside instead.
- **Spend (D10):** the estimate is the run's high estimate. A call runs straight away only if it is at most $0.50 and fits what's left of the token's $10 this month. Otherwise it returns `pending_confirmation` with a `/confirm` link.
  - The $10 is tracked in budget_periods scope `pat` (scope_ref = the token id). A run the token started unconfirmed carries `input.agent`, so `budgetScopesForRun` reserves every paid call against that scope too. A confirmed run skips the token's scope, but the workspace limit always applies.
  - On `/confirm` the price is worked out again from the link's input. Confirm mints the confirm token (HMAC over the tool, a hash of the workspace, token and input, and the estimate, valid 10 minutes). The agent passes it back as `confirmToken`, and each one works once: its nonce is saved in the call's audit row.
- **Transport:** `POST/GET/DELETE /api/mcp`, MCP Streamable HTTP, stateless, with JSON responses. It uses the SDK's low-level `Server` so that every call goes through `invokeTool`. `@modelcontextprotocol/sdk` is pinned to `~1.30.1`, because 1.31 is newer than the release-age window.
- **Auth:** the endpoint only reads `Authorization: Bearer`, never cookies. Everywhere else a request with a bearer token counts as signed out. `requireUiSession`, which guards approve, void, finalize, verify and accept, answers it with 403.
- **Env:** no new variables. `/confirm` uses the existing `CONFIRM_TOKEN_SECRET`, which must be at least 32 characters.
- **Setup:** `claude mcp add --transport http mkt https://<host>/api/mcp --header "Authorization: Bearer <token>"`, shown in Settings → Agent access.
- **Left for later M5 work:** the CLI, the SEO generator, capture PATs, and a claim-verification action (which must take a UiSession).
