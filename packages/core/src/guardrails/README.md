# §8 guardrail tests

One test file per §8 row. Each test checks its rule by calling the code that enforces it (the real publish path, validators, stores and schemas) with fakes only at the edges (the publisher, Claude, Resend, storage, the renderer). Nothing here re-implements a rule.

- `it.todo("… — M5/M6/M8")` means that part of the row isn't built yet.
- `it.fails("GAP: …")` means the rule is **not enforced today**. The test says what should happen and fails until the fix lands. When it lands, vitest reports the test as unexpectedly passing: change it to `it`.
- Some rows can't be checked from core because core doesn't depend on `@mkt/video`. Those live in `packages/video/src/guardrails/`.

## Run

```sh
pnpm --filter @mkt/core exec vitest run src/guardrails
pnpm --filter @mkt/video exec vitest run src/guardrails
```

## Row → file

| §8 row | Test file(s) |
|---|---|
| Approvals (hash-bound, UI-only, re-approve on change) | `approvals.test.ts` |
| Claims and testimonials | `claims.test.ts` |
| Sources (public vs internal vs third-party) | `sources.test.ts` |
| Competitor claims (30-day expiry, stale sweep) | `competitor-claims.test.ts` |
| No invented links, no vote requests | `links-votes.test.ts` |
| Unique content (near-duplicates, one opening line per master) | `unique-content.test.ts` |
| Volume caps | `volume-caps.test.ts` |
| TikTok composer UX | `tiktok-composer.test.ts`, `packages/video/src/guardrails/tiktok-watermark.test.ts` |
| AI provenance tiers and platform flags | `ai-provenance.test.ts` |
| EU AI Act Art. 50 (XMP digitalSourceType) | `eu-ai-act.test.ts`, `packages/video/src/guardrails/xmp.test.ts` |
| Endorsements (kit disclosures) | `endorsements.test.ts` |
| Licenses (music, SFX, fonts, device frames) | `licenses.test.ts`, `packages/video/src/guardrails/licenses.test.ts` |
| Email law (CAN-SPAM / GDPR, suppression, spam rate) | `email-law.test.ts` |
| SEO pages | `seo.test.ts` (all M5) |
| Ad spend ($0, paused, 18+) | `ad-spend.test.ts` |
| Assisted-only venues | `assisted-only.test.ts` |
| Capture safety | `capture-safety.test.ts` |
| Prompt injection | `prompt-injection.test.ts` |
| SSRF | `ssrf.test.ts` |
| Secrets (vault, upload scanning) | `secrets.test.ts` |
| Launch-day gates (D20) | `launch-gates.test.ts` |
| X links add-on window (D24) | `x-links.test.ts` |
| Untrusted rendering (D8) | `packages/video/src/guardrails/untrusted-rendering.test.ts`; email HTML escaping in `email-law.test.ts` |

Shared helpers: `harness.ts` (a seeded product and a post on the real publish path) and `video-harness.ts` (the core video pipeline on fakes, with a renderer that logs the order of file edits).

## Known gaps (the `it.fails` and GAP todos)

| Gap | Where the fix belongs |
|---|---|
| Testimonials have no source-date or consent columns | `packages/db/src/schema.ts:462` |
| No claim-verification action exists (it must take a UiSession) | not built |
| Usernames in pains are removed only by a prompt rule | `packages/core/src/ingest/steps.ts:164` (prompt), fix at `:171` |
| Scene overlap is only a warning on X | `packages/core/src/video/qa-rules.ts:226` |
| A music track without a license on file can be used | `packages/core/src/video/audio.ts:262`, `packages/video/src/spec/lint.ts:7` and `:89` |
| Sound effects aren't wired (no license receipt path yet) | `packages/core/src/video/deps.ts:39` |
| `confirmFlow` and `setTrustedOrigin` are UI-only but take a plain user id, not a UiSession | `packages/core/src/capture/flows.ts:139` and `:152` |
