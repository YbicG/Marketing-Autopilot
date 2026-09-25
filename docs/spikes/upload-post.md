# Upload-Post spike (M2 day 1)

Answers from the public docs (read 2026-09-24/25). Each item says **confirmed in docs** (with the page) or **unverified — test on server**. The adapter is `packages/providers/src/publish/upload-post.ts`; every unverified shape sits in one function marked `UNVERIFIED` there. Base URL `https://api.upload-post.com`, auth header `Authorization: Apikey <key>` — confirmed in docs ([upload-video](https://docs.upload-post.com/api/upload-video/)).

## 1. TikTok parameter names
- Privacy: `privacy_level` = `PUBLIC_TO_EVERYONE` | `MUTUAL_FOLLOW_FRIENDS` | `FOLLOWER_OF_CREATOR` | `SELF_ONLY`; if left out, the account default is used (so the composer must always send it). **Confirmed in docs** ([upload-video](https://docs.upload-post.com/api/upload-video/), [upload-photo](https://docs.upload-post.com/api/upload-photo/)).
- Toggles: `disable_comment`, `disable_duet`, `disable_stitch` (duet/stitch are video only). **Confirmed in docs.**
- Brand flags: `brand_content_toggle` (paid partnership), `brand_organic_toggle` (your own business). **Confirmed in docs.**
- AIGC: `is_aigc` (aliases `tiktok_is_ai_generated`; on photos also `is_ai_generated`). **Confirmed in docs.**
- Photo mode: `POST /api/upload_photos` with `photos[]` (up to 35), `auto_add_music`, `photo_cover_index`; title ≤90, description ≤4000. **Confirmed in docs** ([upload-photo](https://docs.upload-post.com/api/upload-photo/), [character-limits](https://docs.upload-post.com/resources/character-limits/)). Whether `description` is the photo caption (we send the short title in `title`, the caption in `description`): **unverified — test on server** (`captionFields`).
- Direct post vs drafts: `post_mode` = `DIRECT_POST` | `MEDIA_UPLOAD` (alias `tiktok_upload_to_draft`). **Confirmed in docs.**
- `disable_inbox_fallback=true`: on the active-user cap the upload fails with `error_code: "reached_active_user_cap"` instead of landing in drafts; without it the result carries `fallback_to_inbox: true` (also on status/history since Aug 2026). Business-plan accounts never fall back. **Confirmed in docs** ([reached-active-user-cap-error](https://docs.upload-post.com/guides/reached-active-user-cap-error/)).
- Creator info: `GET /api/uploadposts/tiktok/settings?profile=<username>` → `privacy_level_options`, `max_video_post_duration_sec`, `comment_disabled`, `duet_disabled`, `stitch_disabled`. **Confirmed in docs** ([get-tiktok-settings](https://docs.upload-post.com/api/get-tiktok-settings/)). No `can_post`; we treat "has privacy options" as can-post: **unverified**.
- Limits: 6 posts/min and 15/day per TikTok account. **Confirmed in docs.**

## 2. Async multipart upload and status
- `async_upload=true` on `/api/upload`, `/api/upload_photos`, `/api/upload_text` → `200 {success, message, request_id, total_platforms}`. **Confirmed in docs** ([upload-video](https://docs.upload-post.com/api/upload-video/), [async-uploads](https://docs.upload-post.com/guides/async-uploads/)).
- Status: `GET /api/uploadposts/status?request_id=` (or `job_id=` for scheduled posts) → `{request_id, external_id, status, completed, total, results[{platform, success, message, upload_timestamp, skipped?, skip_reason?, fallback_to_inbox?}], last_update}`; statuses `pending|queued|processing|in_progress|completed|failed|not_found(404)`; `failed` also means "no activity for 1+ hour". **Confirmed in docs** ([upload-status](https://docs.upload-post.com/api/upload-status/)).
- A platform row can say `success: true, message: "Queued"` while still in progress, so we only trust a row once the top status is terminal. The status rows don't document a post URL; we fetch `post_url` from history: **unverified — test on server** (does the status row carry `url`/`post_url`?).
- `/api/upload_document` has no documented async mode; we send it synchronously. **Unverified — test on server** (does `async_upload` work there?).
- Polling guidance: first poll after 5 s; photos every 5–10 s, small video every 10 s, large every 15 s; status is cached 2–3 s while running. **Confirmed in docs** ([rate-limits](https://docs.upload-post.com/guides/rate-limits/)).
- Upload timeout: we allow 30 s + 2 s/MB (max 15 min) per upload, since a 30 s API deadline can't carry a video body.

## 3. `external_id` and at-most-once submit
- `external_id` (≤255 chars; also header `X-External-Id`) is echoed in status and stored in history; `GET /api/uploadposts/history?external_id=<id>` is an exact-match lookup. **Confirmed in docs** ([upload-history](https://docs.upload-post.com/api/upload-history/), [upload-status](https://docs.upload-post.com/api/upload-status/)).
- A client-supplied `request_id` (form field or `X-Request-Id`) lets you poll status even if the upload response was lost. **Confirmed in docs.** We send `request_id = external_id = idempotency key`.
- `Idempotency-Key` header: "if a matching upload job already exists, the API returns the existing job instead of creating a duplicate." **Confirmed in docs** ([upload-photo](https://docs.upload-post.com/api/upload-photo/)). We send it on every submit.
- Our lookup order: status by request_id (knows running uploads) → history by external_id → only both missing = `absent`. Whether the status endpoint answers for a client-supplied request_id that equals external_id, how long status rows live, and what a replayed `Idempotency-Key` returns (200 with the old request_id? 409?): **unverified — test on server** (submit twice with the same key; kill the connection mid-upload and look it up).

## 4. Instagram
- Carousel = `/api/upload_photos` with several `photos[]`; `media_type` = `IMAGE` | `STORIES` for photos (`REELS` | `STORIES` for video). **Confirmed in docs.**
- `is_ai_generated` "applies to the whole post" for carousels, i.e. the parent. **Confirmed in docs** ([ai-content-labeling](https://docs.upload-post.com/guides/ai-content-labeling/)).
- JPEG re-hosting: docs list IG photo formats as PNG, JPEG, GIF, ≤8 MB, aspect 4:5–1.91:1, and say nothing about converting or re-hosting. **Unverified — test on server**: send a PNG and a WebP carousel; until then validate() blocks non-JPEG/PNG and the renderer should output JPEG.
- Carousel maximum isn't stated; caps use 10. **Unverified.** Mixed image/video carousels are allowed in `photos[]`. **Confirmed in docs.**

## 5. YouTube
- `containsSyntheticMedia` and `selfDeclaredMadeForKids` (not `madeForKids`; the adapter maps the alias), plus `privacyStatus`, `tags`, `categoryId` (default 22). **Confirmed in docs** ([upload-video](https://docs.upload-post.com/api/upload-video/)). Title ≤100, description ≤5000. **Confirmed in docs.**
- Array encoding for `tags` in multipart (we send repeated `tags[]`): **unverified — test on server.**

## 6. X
- `made_with_ai` — "media posts only". **Confirmed in docs** ([ai-content-labeling](https://docs.upload-post.com/guides/ai-content-labeling/)).
- Links add-on: without it every URL is stripped from caption, title and first comment; with it (\$19/mo, 50 link-posts/month shared across X profiles, then stripping resumes) links survive. Account-level; no API parameter. **Confirmed in docs** ([x-links-addon](https://docs.upload-post.com/guides/x-links-addon/)).
- Platform name: `/api/upload` lists `twitter` in `platform[]`, while `/api/upload_text`, overrides (`x_title`) and status examples use `x`. We send `x`. **Unverified — test on server** (`upPlatform`).

## 7. Which AI flags pass through per platform
| Platform | Flag | Status |
|---|---|---|
| TikTok | `is_aigc` | confirmed in docs |
| Instagram | `is_ai_generated` (whole post) | confirmed in docs |
| YouTube | `containsSyntheticMedia` | confirmed in docs |
| X | `made_with_ai` (media posts only) | confirmed in docs |
| Facebook | `facebook_is_ai_generated` (Reels only; other posts auto-detected) | confirmed in docs |
| LinkedIn | none (labels from C2PA credentials in the file) | confirmed in docs |
| Pinterest | `pinterest_ai_disclosures` exists for video; otherwise IPTC detection | confirmed in docs; not used |
| Threads, Bluesky | none documented | unverified — assume none |

The cross-platform alias `is_ai_generated=true` works on `/api/upload` and `/api/upload_photos` (confirmed in docs), but we send each platform's native name. Where no flag exists, validate() warns and §5.8 applies: add a caption label or block tiers B/C.

## 8. LinkedIn documents
`POST /api/upload_document`, field `document` (file or URL), LinkedIn only, PDF/PPT/PPTX/DOC/DOCX, ≤100 MB, ≤300 pages, `title` required (≤400), `description` = commentary, `visibility`, `target_linkedin_page_id`. Response has `document_urn`, `post_id`, URL; errors carry `error_source` (`client` | `platform`). **Confirmed in docs** ([upload-document](https://docs.upload-post.com/api/upload-document/)). `external_id` support on this endpoint: **unverified.**

## 9. Failure signals, webhook retries, email notifications
- Sync results: per-platform `{success:false, error}`; unconnected platform: `{success:false, skipped:true, error_code:"profile_platform_mapping_invalid"}`. HTTP 400/401/403 (plan)/404 (user)/429 (limit, includes `usage`)/500. **Confirmed in docs** ([upload-video](https://docs.upload-post.com/api/upload-video/), [error-handling](https://docs.upload-post.com/guides/error-handling/)). A full `error_code` list isn't published: **unverified.**
- Rate limits: 429 with `X-RateLimit-Limit/Remaining/Reset`; Basic ≈ 60–100 req/min + 2/min per profile. **Confirmed in docs** ([rate-limits](https://docs.upload-post.com/guides/rate-limits/)).
- Webhooks: configured with `POST /api/uploadposts/users/notifications` (account-level, plus optional per-profile hooks with event filters). Events: `upload_completed`, `social_account_connected`, `social_account_disconnected`, `social_account_reauth_required`. Headers `X-Upload-Post-Signature: sha256=<hex>`, `X-Upload-Post-Timestamp` (unix s), `X-Upload-Post-Event`, `X-Upload-Post-Delivery` (unique id → our dedupe key). Signature = `HMAC_SHA256(secret, "<timestamp>.<raw body>")`; the secret is created when the webhook URL is first saved and rotated with `POST /api/uploadposts/users/webhook-secret`. Answer within 10 s; after 5 consecutive failed deliveries the channel pauses for 30 min. **Confirmed in docs** ([webhooks](https://docs.upload-post.com/api/webhooks/)). We refuse timestamps more than 5 min off.
- Unverified — test on server: whether a failed upload arrives as `upload_completed` with `result.success=false` (we assume so), whether the payload carries `request_id`/`external_id` for async uploads (the example only has `job_id`), whether `fallback_to_inbox` appears in the webhook, and whether single failed deliveries are retried before the pause.
- Email notifications: not in the API docs. **Unverified — check the dashboard settings** and turn them on (§13).

## 10. Connect links on the Basic plan
`POST /api/uploadposts/users/generate-jwt {username, platforms[], redirect_url, …}` → `{access_url, duration: "48h"}`. **Confirmed in docs** ([user-profiles](https://docs.upload-post.com/api/user-profiles/)). But the pricing page lists **"Whitelabel integration: No"** on Basic ($24/mo, 5 profiles) ([pricing-and-limits](https://docs.upload-post.com/resources/pricing-and-limits/)). **Unverified — test on server**: whether generate-jwt works on Basic (maybe unbranded only). Fallback: CJ connects accounts inside the Upload-Post dashboard per profile, and the app only reads health.
- Profiles: `POST /api/uploadposts/users {username}` (201; 409 = exists; 403 `PROFILE_LIMIT_REACHED`), `GET /api/uploadposts/users/{username}` → `social_accounts{platform: {handle, display_name, reauth_required, …} | ""}`, `DELETE /api/uploadposts/users {username}`. **Confirmed in docs.** Token expiry per account isn't documented: **unverified** (`mapHealth`).

## 11. Per-post analytics and comments
- `GET /api/uploadposts/post-analytics/{request_id}?platform=` → per platform `platform_post_id`, `post_url`, `post_metrics`, profile snapshots; also by `platform_post_id&platform&user`, and a cached bulk list. TikTok extras: `reach`, `favorites`, `new_followers`, `profile_views`, watch-time and retention. `GET /api/uploadposts/platform-metrics` (no auth) lists each platform's metric names. **Confirmed in docs** ([get-analytics](https://docs.upload-post.com/api/get-analytics/)).
- The exact keys inside `post_metrics` per platform: **unverified — call `/api/uploadposts/platform-metrics` on day 1 and fix `METRIC_KEYS`**. Zeros are stored as unknown (§5.9).
- Comments: `GET /api/uploadposts/comments?platform&user&post_id|post_url` and `POST /api/uploadposts/comments/create {platform, user, message, comment_id|post_id|post_url}` for IG, FB, YouTube, LinkedIn, TikTok, X, Threads, Bluesky (IG: replies only; TikTok always needs `post_id`). **Confirmed in docs** ([comments](https://docs.upload-post.com/api/comments/)). Plan availability: **unverified.**

## Server checklist (in this order)
1. Paste the key; `GET /api/uploadposts/users` returns the plan and profile limit.
2. `GET /api/uploadposts/platform-metrics` → fix `METRIC_KEYS`.
3. Create a profile, try generate-jwt on Basic.
4. Text post to X with `platform[]=x`, async, our request_id; poll status; look it up by external_id in history; repeat the same Idempotency-Key.
5. TikTok photo post (SELF_ONLY, `auto_add_music`) and check where title vs description show up.
6. IG carousel with a PNG and `is_ai_generated=true`; check the label in the app.
7. Save the webhook URL and secret; check the signature, the payload fields for an async upload and for a failure.
8. Save the raw responses as fixtures for replay mode.
