# M3b recorded demos: deployment notes

How the recorded-demo pipeline (§5.6 step 1, D26) is wired on the Dokploy server. The app records
demos only from a **trusted origin**: an internal demo instance with seeded data that nothing outside
the server can reach and that never touches production data.

```
             mkt network (private)                mkt-capture network (external, internal-only)
  postgres ─┐                                   ┌─ syllacal-demo:3000   (no domain, no Traefik)
  redis ────┼── worker ─────────────────────────┘
  smokescreen ┘     └─ capture Chromium: proxy = smokescreen, bypass = syllacal-demo only
```

## 1. SyllaCal side (a small PR in the SyllaCal repo)

1. **`DEMO_MODE` seed.** When `DEMO_MODE=1`:
   - on boot, if the demo DB is empty, seed one demo student with a demo semester (4–5 courses, a
     parsed syllabus each, a month of events). Use RFC 2606 names only for anything that looks like
     personal data: emails at `@example.com` or `*.test`, phone numbers left out. The personal-data
     scan ignores those domains, and flags anything else.
   - a credentials login for the demo user only (username + password from env), so capture can log in
     without Google OAuth. If SyllaCal has no password login, add `GET/POST /demo/login` behind
     `DEMO_MODE` that checks `DEMO_LOGIN_PASSWORD` and sets the normal session cookie.
   - paid or outbound actions are stubbed: `/api/parse` returns a canned result (no Anthropic call),
     checkout/Stripe routes return 404, email sending is a no-op. The capture route denylist blocks
     these too; the stubs are a second layer.
   - no analytics, no Sentry, no outbound webhooks.
2. **`compose.demo.yml`** in the SyllaCal repo:

   ```yaml
   name: syllacal-demo
   services:
     syllacal-demo:
       build: { context: ., dockerfile: Dockerfile }
       restart: unless-stopped
       environment:
         NODE_ENV: production
         DEMO_MODE: "1"
         PORT: "3000"
         DATABASE_URL: file:/data/demo.db        # or a demo-only Postgres in this same compose file
         DEMO_LOGIN_USERNAME: ${DEMO_LOGIN_USERNAME}
         DEMO_LOGIN_PASSWORD: ${DEMO_LOGIN_PASSWORD}
       volumes: [demo-data:/data]
       networks: [mkt-capture]
       mem_limit: 512m
       # no ports:, no Traefik labels, no dokploy-network
   volumes:
     demo-data: {}
   networks:
     mkt-capture: { external: true }
   ```

   The service name must be exactly `syllacal-demo` (that's the hostname the worker uses). It must
   not share a database, Redis or secrets with production SyllaCal.
3. **Deploy it as its own Dokploy Compose service** from the SyllaCal repo, compose path
   `compose.demo.yml`, with **no domain**. Put `DEMO_LOGIN_USERNAME` / `DEMO_LOGIN_PASSWORD` in that
   service's Environment tab.

## 2. The network (once, on the server)

```sh
docker network create --internal mkt-capture
```

`--internal` means containers on it get no route to the internet, so the demo can't call out even if
a stub is missed. Only two things join it: `syllacal-demo` and the Marketing `worker`. The worker still
reaches the internet through Smokescreen on the private `mkt` network.

## 3. Marketing side: the `compose.prod.yml` change (not made yet; apply by hand)

Only the worker joins `mkt-capture`:

```diff
   worker:
     ...
-    networks: [mkt]
+    networks: [mkt, mkt-capture]
     ...

 networks:
   mkt: {}
   dokploy-network: { external: true }
+  mkt-capture: { external: true }
```

`web`, `migrate`, `postgres`, `redis` and `smokescreen` stay off it. If the network doesn't exist when
Dokploy deploys, compose fails: create it first (step 2).

## 4. Register the trusted origin (in the UI)

Product → Settings → Recorded demos:

- **Demo site address:** `http://syllacal-demo:3000`. `setTrustedOrigin` accepts only
  `http(s)://<docker-service-name>:<port>`: lowercase service name, no dots, no IPs, no path, and never
  one of the app's own services (`postgres`, `redis`, `web`, `worker`, `smokescreen`, `dokploy*`, …).
- **Paths capture must never call:** start from the suggestion `/api/checkout`, `/api/parse`,
  `/api/stripe`, `/api/webhooks`, `/api/email`, `/api/send`, `/api/**/email*`, `/api/**/send*`.
  Plain entries are prefixes; `*` is one path part, `**` any number.
- **Test login:** saved in the vault under purpose `capture.login.<productId>` as
  `{ "username", "password", "loginPath"? }` (default `loginPath` is `/login`; use `/demo/login` if
  that's what the PR adds). It's used only in a separate, never-recorded browser context.

## 5. What the recorder enforces

- One Chromium per capture: proxy `SMOKESCREEN_URL` with `bypass` = the trusted host only,
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
- `context.route` (guard.ts `isAllowedRequest`): only the trusted origin and its own assets plus
  `data:`/`blob:`; payment hosts (Stripe, PayPal, `checkout.*`…) aborted first; everything off the
  origin aborted (non-GET ones counted as `off_origin_write` in the asset's
  `origination.blockedRequests`); route-denylist paths aborted; `DELETE` and writes to paths naming a
  blocked action aborted even with an empty denylist; WebSockets off the origin closed; popups closed;
  dialogs dismissed; downloads and service workers off.
- Every request carries `X-Mkt-Capture: 1` and the user agent ends in ` MktCapture/1`, so SyllaCal's
  analytics can drop them.
- Login: separate context → `storageState` → the recording context. The login page is never on screen
  in the recording.
- Clicks: cursor glides in 25 steps, then the element actually under the cursor (text, aria-label,
  title, value, id, alt) is checked against the action denylist before the click. Enter/Space checks
  the focused form's buttons first.
- Frames: CDP `Page.startScreencast` (JPEG, every frame, acked) with compositor timestamps →
  `framesToCfr` → 30 fps CFR H.264 mp4. Click log (0..1 coordinates) saved as
  `ws/<id>/assets/<sha>-clicks.json`.
- Personal data: regexes (emails, phones, API keys via secret-scan rules, Luhn-valid cards) over the
  page text after every step, plus a `qa.pii_frames` vision pass on one frame per second. Any hit sets
  `assets.pii_hits` and the flow's status says "Needs you".

## 6. Checks on the server (§12.3 M3b)

1. From the worker container: `wget -qO- http://syllacal-demo:3000/ | head` works; from the `web`
   container it must fail (name doesn't resolve).
2. From the demo container: `wget -qO- https://example.com` must fail (internal network).
3. Record 3 SyllaCal flows. For each recording: `origination.blockedRequests.off_origin_write` may be
   non-zero (those were aborted), but SyllaCal's demo logs show no request to a denylisted path and
   production SyllaCal's logs show no `MktCapture/1` traffic at all.
4. Watch the footage: the login screen never appears; `pii_hits` is false.
5. Serve `packages/testing/fixtures/capture-danger/index.html` as a throwaway trusted origin (a
   one-line static container on `mkt-capture`) and run a flow that tries to click Buy, Delete and Send:
   the flow must stop with "Stopped before clicking …" and the checkout POST must be aborted.
