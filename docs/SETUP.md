# Setting up Marketing Autopilot on Dokploy

The app runs only on your Dokploy server. The laptop never runs it. Pushing to `main` deploys.

Day 1 needs only **steps 1–5**. Add everything else when you need it: the app shows a card when a key would unlock something.

## 1. Server
- Open only ports 22, 80 and 443 in the firewall.
- Put the Dokploy dashboard on its own domain, with 2FA turned on.
- Plan on at least 4 vCPU and 8 GB free. The worker logs what it sees at boot.

## 2. DNS (Cloudflare)
- Add an **A record** pointing `app.<domain>` at the server IP.
- Leave it **DNS only (grey cloud)**, so Let's Encrypt can issue the certificate.

## 3. GitHub OAuth app (for logging in)
- GitHub → Settings → Developer settings → OAuth Apps → New.
- Set the callback URL to `https://app.<domain>/api/auth/callback/github`.
- If GitHub offers to opt out of expiring user tokens, opt out.
- Copy the Client ID and create a Client secret.

## 4. Anthropic
- Create an API key.
- In the Console, **turn on web search** for the org.
- Set a Console spend limit a little above the app's monthly limit (the app's default is $60).

## 5. Dokploy service
1. Create a project called `marketing`, then add a **Compose** service.
2. Provider: GitHub → `YbicG/Marketing-Autopilot`, branch `main`, compose path `compose.prod.yml`. Turn on **auto-deploy**.
3. **Environment tab.** Generate the random values with `openssl rand -base64 32`, or `-base64 48` where noted.

   | Variable | Value |
   |---|---|
   | `APP_BASE_URL` | `https://app.<domain>` |
   | `BETTER_AUTH_SECRET` | random, 48 bytes |
   | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | from step 3 |
   | `ALLOWED_GITHUB_LOGINS` | your GitHub username (comma-separated for more) |
   | `ANTHROPIC_API_KEY` | from step 4 |
   | `POSTGRES_PASSWORD` / `REDIS_PASSWORD` | random, **letters and digits only** (they go inside URLs) |
   | `SELF_IPS` | the server's public IPs, comma-separated (IPv4 and IPv6) |
   | `MKT_KEK_V1_B64` | random, **exactly** `openssl rand -base64 32`. Back this up: losing it loses every saved key |
   | `CONFIRM_TOKEN_SECRET` | random, 48 bytes |

4. **Domains tab:** host `app.<domain>`, service `web`, port `3000`, HTTPS on (Let's Encrypt).
5. **Deploy.** The order is: `migrate` runs → `web` and `worker` start → the health check on `/api/health` passes.
6. **Check:**
   - Open `https://app.<domain>` and log in with GitHub.
   - The worker log shows its CPUs and memory, and each queue says "ready".

You now have M0–M1: paste a website and get a product profile and a plan.

## 6. Posting (M2): Upload-Post, R2, backups
- **Cloudflare R2:**
  - Create the bucket `mkt-private` and a token scoped to it.
  - Add CORS for GET, HEAD and PUT from `https://app.<domain>`.
  - In the Environment tab, set `STORAGE_DRIVER=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, then redeploy.
  - Keep **Bot Fight Mode off** on this zone, or webhooks break.
- **Upload-Post (Basic plan):**
  - Paste the API key and webhook secret in **Settings → Keys**.
  - Set the webhook to `https://app.<domain>/api/webhooks/upload-post` and turn on email notifications.
  - Connect TikTok, IG and YouTube through **Settings → Where to post**.
- **Optional:**
  - Create a Healthchecks.io check and set `HEALTHCHECK_PING_URL` to its ping URL.
  - Set `FIRSTPARTY_ANALYTICS_TOKEN` to the token for SyllaCal's `/api/marketing/aggregate` endpoint. This powers signups in Results and the launch tracking test.

## 7. Videos (M3a): ElevenLabs
- Get the Starter plan ($6) and **turn off usage-based billing**.
- Paste the key in Settings → Keys. Without it, videos use captions and a bundled music track.

## 8. Recorded demos (M3b, optional)
See `docs/m3b-demo-capture.md`. The steps are:
1. Deploy the SyllaCal demo compose with no domain, on the `mkt-capture` network.
2. Register `http://syllacal-demo:3000` as the project's trusted capture origin.

## 9. Launch (M4-LC): Resend
- Use SyllaCal's verified sending domain (SPF, DKIM, DMARC).
- Create a **full-access** API key and paste it in Settings → Keys.
- Add the webhook `https://app.<domain>/api/webhooks/resend` with the email and contact events. Paste its signing secret in Keys.
- Make a Resend list of past buyers. On the project's **Email** tab, pick that list and fill in the sender and the postal address.
- In January only, add Upload-Post's **X links add-on** ($19/mo). Then set the launch-week window on the Launch tab.

## Checks before launch (M4-LC "done when")
1. On the Launch tab:
   - Make the checklist. It should run D1 Wed Jan 6 → launch Tue Jan 19.
   - Run the **tracking test**: open its link in a private window, then press Check now.
   - Run the **landing check**.
2. Send a test email a few minutes out. It should show "Scheduled at Resend". Edit it: it should vanish from Resend and need approval again.
3. Do a full **Standard** SyllaCal run. It should cost ≤ $12, within ±25% of the estimate. It should be ready to review in ≤ 15 min and complete in ≤ 60 min.
4. Do a launch-day dry run: TikTok set to "Only me", YouTube set to private.
5. Run `pnpm test:guardrails` (it's green locally too), then tag `v1.0-launch`.

## Keys: where each one goes
Keys pasted in **Settings → Keys** are encrypted in the database and are checked first. The Environment tab is a fallback. Each env name is the key's purpose upper-cased, for example `RESEND_API_KEY`, `UPLOAD_POST_API_KEY`, `ELEVENLABS_API_KEY`, `EXA_API_KEY` and `BRAVE_API_KEY`. `.env.example` lists every variable.
