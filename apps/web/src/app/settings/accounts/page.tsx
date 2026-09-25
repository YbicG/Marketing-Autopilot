import Link from "next/link";
import { redirect } from "next/navigation";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "@mkt/contracts";
import { env } from "@mkt/core/config";
import { configuredPurposes } from "@mkt/core/cost";
import { listSecrets } from "@mkt/core/security";
import { getWorkspace, listConnections, listProducts } from "@mkt/core/tenancy";
import { SECRET_API_KEY, SECRET_WEBHOOK } from "@mkt/providers";
import { SettingsTabs } from "@/components/project-tabs";
import { KeyForm } from "@/components/settings/key-form";
import { shortDate, vaultStatus } from "@/components/settings/vault";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../header";
import { ConnectPanel, ProfileButton, type PlatformRow } from "./connect-panel";
import { HealthList, SyncOnReturn, type HealthRow } from "./health-list";

export const dynamic = "force-dynamic";

const LABEL: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  threads: "Threads",
  youtube: "YouTube",
  x: "X",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
};

/** §13 account-type advice, shown next to each connect link. */
const ADVICE: Record<SocialPlatform, string> = {
  tiktok: "Use a TikTok Business account for the project. New accounts post once a day for the first week.",
  instagram: "Switch the account to professional (Creator or Business) first, or posting won't work.",
  threads: "Uses the same Instagram professional account.",
  youtube: "Use a brand account for the project rather than your personal channel.",
  x: "Your personal account is fine. It's shared across projects, so its daily limit covers all of them. Links in posts need Upload-Post's X links add-on; otherwise the link goes in your bio.",
  linkedin: "Your personal profile is fine. It's shared across projects, so its daily limit covers all of them.",
  bluesky: "Your personal account is fine. It's shared across projects, so its daily limit covers all of them.",
};

const ORDER: SocialPlatform[] = ["tiktok", "instagram", "threads", "youtube", "x", "linkedin", "bluesky"];
const labelFor = (p: string) => LABEL[p as SocialPlatform] ?? p;

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ connected?: string }> }) {
  const { connected } = await searchParams;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const [products, connections, configured, secrets] = await Promise.all([
    listProducts(db, s.workspaceId),
    listConnections(db, s.workspaceId),
    configuredPurposes(db, s.workspaceId),
    listSecrets(db, s.workspaceId),
  ]);
  const vault = vaultStatus();
  const stored = new Set(secrets.map((x) => x.purpose));
  const hasKey = configured.has(SECRET_API_KEY);
  const hasWebhook = configured.has(SECRET_WEBHOOK);
  const active = products.filter((p) => p.status === "active");
  const platforms = ORDER.filter((p) => SOCIAL_PLATFORMS.includes(p));

  const healthRows: HealthRow[] = connections.map((c) => ({
    id: c.id,
    productId: c.productId,
    project: c.productName ?? "No project",
    platform: c.platform,
    platformLabel: labelFor(c.platform),
    handle: c.handle,
    status: c.status,
    tokenExpires: c.tokenExpiresAt ? shortDate(c.tokenExpiresAt) : "Not reported",
    lastCheck: c.lastHealthAt ? `${shortDate(c.lastHealthAt)} ${c.lastHealthAt.toISOString().slice(11, 16)} UTC` : "Never",
    maxPerDay: c.maxPerDay,
    shared: c.shared,
  }));

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <SettingsTabs />
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8">
        <div>
          <h1 className="text-xl font-semibold">Where to post</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Posts go out from your server through Upload-Post, at the times you approve. You sign in to each platform on its own page; this app never
            sees those logins. Until this is set up, approved posts wait for you to download and post them yourself.
          </p>
        </div>

        {connected === "1" && <SyncOnReturn />}
        {!vault.ready && (
          <p className="rounded-md border border-amber-900/70 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">{vault.message}</p>
        )}

        <Step n={1} title="Add your Upload-Post key" done={hasKey && hasWebhook}>
          <p className="text-sm text-zinc-400">
            Upload-Post Basic costs $16–24/mo. Sign up on{" "}
            <a href="https://www.upload-post.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              their site
            </a>
            , copy the API key, and set the webhook to <span className="font-mono text-zinc-300">{env().APP_BASE_URL}/api/webhooks/upload-post</span>.
            Turn on their email notifications too.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm">API key {hasKey && !stored.has(SECRET_API_KEY) && <span className="text-xs text-sky-300">· using the server&apos;s key</span>}</span>
              <KeyForm purpose={SECRET_API_KEY} label="API key" stored={stored.has(SECRET_API_KEY)} disabled={!vault.ready} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm">
                Webhook secret {hasWebhook && !stored.has(SECRET_WEBHOOK) && <span className="text-xs text-sky-300">· using the server&apos;s key</span>}
              </span>
              <KeyForm purpose={SECRET_WEBHOOK} label="Webhook secret" stored={stored.has(SECRET_WEBHOOK)} disabled={!vault.ready} />
            </div>
          </div>
        </Step>

        <Step n={2} title="One posting profile per project" done={active.length > 0 && active.every((p) => connections.some((c) => c.productId === p.id))}>
          <p className="text-sm text-zinc-400">Each project gets its own profile in Upload-Post, so its accounts and posts stay separate.</p>
          {!hasKey ? (
            <p className="text-sm text-zinc-500">Add the API key above first.</p>
          ) : active.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No projects yet. <Link href="/" className="underline underline-offset-2">Add one</Link> first.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {active.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                  <span>{p.name}</span>
                  <ProfileButton productId={p.id} ready={connections.some((c) => c.productId === p.id)} disabled={!hasKey} />
                </li>
              ))}
            </ul>
          )}
        </Step>

        <Step n={3} title="Connect your accounts" done={active.length > 0 && active.every((p) => connections.some((c) => c.productId === p.id && c.status === "active"))}>
          <p className="text-sm text-zinc-400">
            Connect opens Upload-Post&apos;s page, where you sign in to the platform; you come back here when you&apos;re done. Pick the account type
            below for each one.
          </p>
          {hasKey &&
            active.map((p) => {
              const mine = connections.filter((c) => c.productId === p.id);
              const rows: PlatformRow[] = platforms.map((pl) => {
                const c = mine.find((x) => x.platform === pl);
                return { platform: pl, label: LABEL[pl], advice: ADVICE[pl], status: c?.status ?? null, handle: c?.handle ?? null };
              });
              return (
                <div key={p.id} className="flex flex-col gap-2">
                  <h3 className="font-medium">{p.name}</h3>
                  <ConnectPanel productId={p.id} rows={rows} disabled={!hasKey} />
                </div>
              );
            })}
        </Step>

        <Step n={4} title="Set up your bio and pinned post">
          <p className="text-sm text-zinc-400">
            Each campaign drafts a bio and a pinned post per account, with your tracking link in the bio. Approve them on the Content board, then paste
            them into each profile.
          </p>
          <ul className="flex flex-wrap gap-3 text-sm">
            {active.map((p) => (
              <li key={p.id}>
                <Link href={`/p/${p.slug}/content`} className="underline underline-offset-2">
                  {p.name}: bio and pinned post drafts
                </Link>
              </li>
            ))}
          </ul>
        </Step>

        <Step n={5} title="Send a test post">
          <p className="text-sm text-zinc-400">
            Approve one post for the next open slot in the Queue. When it shows as posted, open the link in a private window where you&apos;re logged out
            to confirm everyone can see it. If it isn&apos;t there, check the account&apos;s status below.
          </p>
          <ul className="flex flex-wrap gap-3 text-sm">
            {active.map((p) => (
              <li key={p.id}>
                <Link href={`/p/${p.slug}/queue`} className="underline underline-offset-2">
                  {p.name}: open the Queue
                </Link>
              </li>
            ))}
          </ul>
        </Step>

        <section className="flex flex-col gap-3" aria-label="Connected accounts">
          <div>
            <h2 className="text-lg font-semibold">Connected accounts</h2>
            <p className="text-sm text-zinc-400">Checked every 6 hours. When a platform asks you to sign in again, posts to it wait until you reconnect.</p>
          </div>
          <HealthList rows={healthRows} />
        </section>
      </main>
    </>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-zinc-800 p-4" aria-label={title}>
      <h2 className="flex items-center gap-3 font-semibold">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-300"}`}
        >
          {done ? "✓" : n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}
