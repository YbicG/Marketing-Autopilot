import { redirect } from "next/navigation";
import { CAPABILITIES, CAPTURE_LOGIN_RE, captureLoginPurpose, isConnected, KNOWN_PURPOSES, type Capability } from "@mkt/core/cost";
import { listSecrets } from "@mkt/core/security";
import { getWorkspace, listProducts } from "@mkt/core/tenancy";
import { SettingsTabs } from "@/components/project-tabs";
import { KeyForm, LoginForm } from "@/components/settings/key-form";
import { shortDate, vaultStatus } from "@/components/settings/vault";
import { env } from "@mkt/core/config";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../header";

export const dynamic = "force-dynamic";

type Stored = { purpose: string; hint: string | null; createdAt: Date; rotatedAt: Date | null };

/** Where a purpose resolves from, without ever reading a value (D19: vault first, then env). */
function sourceLine(stored: Stored | undefined, envName: string | undefined): { text: string; tone: string } {
  if (stored) {
    const when = stored.rotatedAt ? `replaced ${shortDate(stored.rotatedAt)}` : `added ${shortDate(stored.createdAt)}`;
    return { text: `Saved${stored.hint ? ` · ends in ${stored.hint}` : ""} · ${when}`, tone: "text-emerald-400" };
  }
  // Presence only: the server's value is never read into the page.
  if (envName && process.env[envName]) return { text: "Using the server's key", tone: "text-sky-300" };
  return { text: "Not set", tone: "text-zinc-500" };
}

export default async function KeysPage() {
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const [secrets, products] = await Promise.all([listSecrets(db, s.workspaceId), listProducts(db, s.workspaceId)]);
  const vault = vaultStatus();
  const byPurpose = new Map(secrets.map((x) => [x.purpose, x]));
  const configured = new Set([
    ...byPurpose.keys(),
    ...[...KNOWN_PURPOSES].filter(([, { secret }]) => secret.envName && process.env[secret.envName]).map(([p]) => p),
  ]);
  const productIds = new Set(products.map((p) => p.id));
  const other = secrets.filter((x) => !KNOWN_PURPOSES.has(x.purpose) && !(CAPTURE_LOGIN_RE.test(x.purpose) && productIds.has(x.purpose.slice(14))));

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <SettingsTabs />
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8">
        <div>
          <h1 className="text-xl font-semibold">Keys</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Add a service when you want what it unlocks. Keys are encrypted on your server and never shown again after you save them. A key set in
            Dokploy&apos;s Environment tab works too; one saved here takes priority.
          </p>
        </div>

        {!vault.ready && (
          <p className="rounded-md border border-amber-900/70 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">{vault.message}</p>
        )}

        <section className="grid gap-4 md:grid-cols-2" aria-label="Services">
          {CAPABILITIES.map((c) => (
            <CapabilityCard
              key={c.id}
              c={c}
              connected={isConnected(c, configured)}
              byPurpose={byPurpose}
              disabled={!vault.ready}
              note={c.id === "upload_post" ? `In Upload-Post, set the webhook to ${env().APP_BASE_URL}/api/webhooks/upload-post and turn on email notifications.` : undefined}
            />
          ))}
        </section>

        <section className="flex flex-col gap-3" aria-label="Demo test logins">
          <div>
            <h2 className="text-lg font-semibold">Demo test logins</h2>
            <p className="text-sm text-zinc-400">
              For recording demos of screens behind a sign-in. Use a test account on your demo copy, never a real one. The login is used only to sign
              in and is never recorded or shown again.
            </p>
          </div>
          {products.length === 0 ? (
            <p className="text-sm text-zinc-500">Add a project first.</p>
          ) : (
            products.map((p) => {
              const stored = byPurpose.get(captureLoginPurpose(p.id));
              return (
                <div key={p.id} className="flex flex-col gap-2 rounded-md border border-zinc-800 p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-medium">{p.name}</h3>
                    <span className={`text-xs ${stored ? "text-emerald-400" : "text-zinc-500"}`}>
                      {stored ? `Saved · ${stored.rotatedAt ? `replaced ${shortDate(stored.rotatedAt)}` : `added ${shortDate(stored.createdAt)}`}` : "Not set"}
                    </span>
                  </div>
                  <LoginForm productId={p.id} stored={!!stored} disabled={!vault.ready} />
                </div>
              );
            })
          )}
        </section>

        {other.length > 0 && (
          <section className="flex flex-col gap-3" aria-label="Other saved keys">
            <h2 className="text-lg font-semibold">Other saved keys</h2>
            <p className="text-sm text-zinc-400">Nothing in the app uses these right now. You can remove them.</p>
            {other.map((x) => (
              <div key={x.purpose} className="flex flex-col gap-2 rounded-md border border-zinc-800 p-4">
                <p className="text-sm">
                  <span className="font-mono text-zinc-300">{x.purpose}</span>
                  <span className="text-zinc-500"> · added {shortDate(x.createdAt)}</span>
                </p>
                <KeyForm purpose={x.purpose} label="Key" stored disabled />
              </div>
            ))}
          </section>
        )}
      </main>
    </>
  );
}

function CapabilityCard({
  c,
  connected,
  byPurpose,
  disabled,
  note,
}: {
  note?: string;
  c: Capability;
  connected: boolean;
  byPurpose: Map<string, Stored>;
  disabled: boolean;
}) {
  return (
    <article className={`flex flex-col gap-3 rounded-md border p-4 ${connected ? "border-emerald-900/70" : "border-zinc-800"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">
          {c.name}
          {c.optional && <span className="ml-2 text-xs font-normal text-zinc-500">optional</span>}
        </h2>
        <span className="text-sm text-zinc-400">{c.priceLabel}</span>
      </div>
      <p className="text-sm text-zinc-300">
        <span className="text-zinc-500">Unlocks: </span>
        {c.unlocks}
      </p>
      {!connected && (
        <p className="text-sm text-zinc-400">
          <span className="text-zinc-500">Without it: </span>
          {c.without}
        </p>
      )}
      {note && <p className="text-xs text-zinc-400">{note}</p>}
      {c.anyOf && <p className="text-xs text-zinc-500">Either key is enough.</p>}
      <div className="flex flex-col gap-3">
        {c.secrets.map((sec) => {
          const stored = byPurpose.get(sec.purpose);
          const line = sourceLine(stored, sec.envName);
          return (
            <div key={sec.purpose} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>{sec.label}</span>
                <span className={`text-xs ${line.tone}`}>{line.text}</span>
              </div>
              <KeyForm purpose={sec.purpose} label={sec.label} stored={!!stored} disabled={disabled} />
            </div>
          );
        })}
      </div>
      <a href={c.signupUrl} target="_blank" rel="noreferrer" className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
        Sign up or find your key on {c.name.split(" ")[0]}&apos;s site
      </a>
    </article>
  );
}
