import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AngleCard, type FieldMetaMap, type ProductDna } from "@mkt/contracts";
import { assetsFor, planView, productBySlug, type SourceRef } from "@mkt/core/ingest";
import { getWorkspace } from "@mkt/core/tenancy";
import { SourceLink } from "@/components/source-link";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/session";
import { Header } from "../../../header";
import { FieldActions } from "./field-actions";
import { LaunchDate } from "./launch-date";
import { PlanActions } from "./plan-actions";
import { StrategyWaiting } from "./strategy-waiting";
import { UnsureList, type UnsureItem } from "./unsure-list";

export const dynamic = "force-dynamic";

/** Plain-English names for every top-level profile field (§2.6). */
const FIELD_LABEL: Record<string, string> = {
  "identity.name": "Name",
  "identity.oneLiner": "In one line",
  "identity.category": "Category",
  "identity.platforms": "Runs on",
  "identity.whoItsFor": "Who it's for",
  "identity.audiences": "Groups of people it's for",
  "identity.jobs": "What they're trying to get done",
  "identity.voice": "How you sound",
  "offer.features": "Features",
  "offer.pricing": "Pricing",
  "offer.proof": "Facts that back it up",
  "offer.differentiators": "What makes it different",
  "market.competitors": "Similar products",
  "market.pains": "What people complain about",
  "market.seasonality": "Busy seasons",
  "market.channels": "Where they spend time online",
  "market.searchTerms": "What they search for",
};

const SECTIONS: { id: keyof ProductDna; title: string }[] = [
  { id: "identity", title: "About the product" },
  { id: "offer", title: "What you offer" },
  { id: "market", title: "The market" },
];

const labelFor = (path: string) => FIELD_LABEL[path] ?? path.split(".").pop() ?? path;

function valueAt(dna: ProductDna, path: string): unknown {
  const [section, key] = path.split(".");
  const sec = (dna as unknown as Record<string, Record<string, unknown> | undefined>)[section ?? ""];
  return sec && key ? sec[key] : undefined;
}

type Ctx = { slug: string; dnaVersionId: string; fields: FieldMetaMap; sourceMap: Record<string, SourceRef> };

export default async function PlanPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await requireWorkspace();
  const db = getDb();
  const ws = await getWorkspace(db, s.workspaceId);
  if (!ws) redirect("/signin");
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) notFound();
  const view = await planView(db, product);
  const { dna, strategy } = view;

  const pendingStrategy = view.runs.find((r) => r.kind === "strategy" && (r.status === "queued" || r.status === "running"));
  const activeRun = view.runs.find((r) => r.kind !== "strategy" && (r.status === "queued" || r.status === "running"));
  const cards = strategy
    ? (strategy.angles.length
        ? strategy.angles.map((a) => AngleCard.safeParse(a.card))
        : strategy.output.angles.map((a) => AngleCard.safeParse(a))
      ).flatMap((p) => (p.success ? [p.data] : []))
    : [];
  const shotIds = [...new Set(cards.flatMap((c) => c.screenshotAssetIds.slice(0, 3)))];
  const known = new Set((shotIds.length ? await assetsFor(db, product.id, shotIds) : []).map((a) => a.id));

  return (
    <>
      <Header workspaceId={s.workspaceId} limitMicros={ws.monthlyLimitMicros} />
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10">
        <div>
          <p className="text-sm text-zinc-500">Here&apos;s your plan</p>
          <h1 className="text-2xl font-semibold">{dna?.dna.identity.name || product.name}</h1>
          {dna?.dna.identity.oneLiner && <p className="mt-1 text-zinc-300">{dna.dna.identity.oneLiner}</p>}
        </div>

        {activeRun && (
          <p className="rounded-md border border-sky-900/70 bg-sky-950/20 px-4 py-3 text-sm">
            We&apos;re still working on this.{" "}
            <Link href={`/runs/${activeRun.id}`} className="underline underline-offset-2">
              Watch the progress
            </Link>
          </p>
        )}

        {!dna ? (
          <p className="text-zinc-400">
            There&apos;s no profile yet.{" "}
            <Link href="/" className="underline underline-offset-2">
              Read your product
            </Link>{" "}
            to make one.
          </p>
        ) : (
          <>
            <UnsureList
              slug={product.slug}
              dnaVersionId={dna.id}
              confirmed={dna.status === "confirmed"}
              items={view.unsure.map<UnsureItem>((u) => ({
                path: u.path,
                label: labelFor(u.path),
                question: u.question,
                value: valueAt(dna.dna, u.path),
              }))}
            />

            <section className="flex flex-col gap-4" aria-label="Your angles">
              <div>
                <h2 className="text-lg font-semibold">Your angles</h2>
                {cards.length > 0 && <p className="text-sm text-zinc-400">We&apos;ll test all 3, mostly #1.</p>}
                {view.strategyIsStale && (
                  <p className="mt-1 text-sm text-amber-300">These angles are from an older version of your profile.</p>
                )}
              </div>
              {pendingStrategy && (!strategy || view.strategyIsStale) && <StrategyWaiting runId={pendingStrategy.id} />}
              {cards.length > 0 ? (
                <ol className="grid gap-4">
                  {cards.map((c, i) => (
                    <AngleView key={i} n={i + 1} card={c} shots={c.screenshotAssetIds.filter((id) => known.has(id)).slice(0, 3)} />
                  ))}
                </ol>
              ) : (
                !pendingStrategy && <p className="text-sm text-zinc-500">No angles yet. Regenerate the profile to pick them.</p>
              )}
            </section>

            {strategy && (
              <LaunchDate
                slug={product.slug}
                strategyId={strategy.id}
                initial={strategy.launchDate}
                reason={strategy.output.launchWindow.reason || null}
              />
            )}

            <details className="rounded-md border border-zinc-800 p-5">
              <summary className="cursor-pointer text-lg font-semibold">Your profile</summary>
              <p className="mt-1 text-sm text-zinc-500">
                Everything we learned, with where it came from. Fix anything that&apos;s wrong, or pin it to keep it as is.
              </p>
              <div className="mt-6 flex flex-col gap-8">
                {SECTIONS.map((sec) => (
                  <ProfileSection
                    key={sec.id}
                    title={sec.title}
                    values={dna.dna[sec.id] as unknown as Record<string, unknown>}
                    prefix={sec.id}
                    ctx={{ slug: product.slug, dnaVersionId: dna.id, fields: dna.fields, sourceMap: dna.sourceMap as unknown as Record<string, SourceRef> }}
                    skip={sec.id === "identity" ? ["voice"] : []}
                  />
                ))}
                <HowYouSound
                  dna={dna.dna}
                  messaging={strategy?.output.messaging ?? null}
                  ctx={{ slug: product.slug, dnaVersionId: dna.id, fields: dna.fields, sourceMap: dna.sourceMap as unknown as Record<string, SourceRef> }}
                />
                <PublicFacts claims={view.claims.filter((c) => c.publicOk && c.status !== "rejected")} />
              </div>
            </details>
          </>
        )}

        <PlanActions slug={product.slug} hasProfile={!!dna} />
      </main>
    </>
  );
}

function AngleView({ n, card, shots }: { n: number; card: AngleCard; shots: string[] }) {
  const main = n === 1;
  return (
    <li className={`flex flex-col gap-3 rounded-md border p-5 ${main ? "border-zinc-400" : "border-zinc-800"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">
          #{n} {card.title}
        </h3>
        {main && <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-900">Main</span>}
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-zinc-500">For</dt>
        <dd>{card.forWho}</dd>
        <dt className="text-zinc-500">Instead of</dt>
        <dd>{card.insteadOf}</dd>
        <dt className="text-zinc-500">The promise</dt>
        <dd>{card.promise}</dd>
        <dt className="text-zinc-500">Opening line</dt>
        <dd className="italic">&ldquo;{card.sampleOpeningLine}&rdquo;</dd>
        {card.bestOn.length > 0 && (
          <>
            <dt className="text-zinc-500">Best on</dt>
            <dd>{card.bestOn.join(", ")}</dd>
          </>
        )}
        <dt className="text-zinc-500">Why we suggest it</dt>
        <dd className="text-zinc-300">{card.whyWeSuggest}</dd>
      </dl>
      {shots.length > 0 && (
        <ul className="flex gap-2 overflow-x-auto">
          {shots.map((id) => (
            <li key={id} className="shrink-0">
              <img
                src={`/api/media/${id}?v=preview`}
                alt="Screenshot for this angle"
                loading="lazy"
                className="h-24 w-40 rounded border border-zinc-800 bg-zinc-900 object-cover object-top"
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ProfileSection({
  title,
  values,
  prefix,
  ctx,
  skip,
}: {
  title: string;
  values: Record<string, unknown>;
  prefix: string;
  ctx: Ctx;
  skip: string[];
}) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-base font-semibold">{title}</h3>
      <dl className="flex flex-col gap-5">
        {Object.entries(values)
          .filter(([k]) => !skip.includes(k))
          .map(([k, v]) => (
            <FieldRow key={k} path={`${prefix}.${k}`} value={v} ctx={ctx} />
          ))}
      </dl>
    </section>
  );
}

function FieldRow({ path, value, ctx }: { path: string; value: unknown; ctx: Ctx }) {
  const meta = ctx.fields[path];
  const label = labelFor(path);
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-sm text-zinc-500">{label}</dt>
      <dd className="flex flex-col gap-2 text-sm">
        <ValueView value={value} />
        <SourceChips ids={meta?.sources ?? []} sourceMap={ctx.sourceMap} />
        <FieldActions slug={ctx.slug} dnaVersionId={ctx.dnaVersionId} path={path} label={label} value={value} pinned={!!meta?.pinned} />
      </dd>
    </div>
  );
}

const PRIMARY = ["name", "title", "text", "months", "platform", "objection", "summary", "tone"];
const SECONDARY = ["description", "howTheyDiffer", "reason", "why", "price", "answer", "role"];

/** Renders a profile value readably: strings, lists, and lists of small records. */
function ValueView({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <p className="text-zinc-500">Not known yet</p>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <p className="whitespace-pre-wrap text-zinc-200">{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-zinc-500">None found</p>;
    return (
      <ul className="list-disc space-y-1 pl-5 text-zinc-200">
        {value.map((v, i) => (
          <li key={i}>{typeof v === "object" && v !== null ? <RecordLine rec={v as Record<string, unknown>} /> : String(v)}</li>
        ))}
      </ul>
    );
  }
  const rec = value as Record<string, unknown>;
  return (
    <div className="flex flex-col gap-1.5 text-zinc-200">
      {Object.entries(rec).map(([k, v]) => (
        <div key={k}>
          <span className="text-xs text-zinc-500">{SUB_LABEL[k] ?? k}</span>
          <ValueView value={v} />
        </div>
      ))}
    </div>
  );
}

const SUB_LABEL: Record<string, string> = {
  model: "How you charge",
  summary: "Summary",
  tiers: "Plans",
  peaks: "Busy times",
  tone: "Tone",
  wordsToUse: "Words to use",
  wordsToAvoid: "Words to avoid",
};

function RecordLine({ rec }: { rec: Record<string, unknown> }) {
  const first = PRIMARY.map((k) => rec[k]).find((v) => typeof v === "string" && v);
  const second = SECONDARY.map((k) => rec[k]).find((v) => typeof v === "string" && v);
  const url = typeof rec.url === "string" ? rec.url : typeof rec.sourceUrl === "string" ? rec.sourceUrl : null;
  const period = typeof rec.period === "string" && rec.period ? ` ${rec.period}` : "";
  const extra = Array.isArray(rec.painPoints) ? (rec.painPoints as unknown[]).filter((x) => typeof x === "string") : [];
  return (
    <span>
      {typeof first === "string" && <span className="font-medium">{first}</span>}
      {typeof second === "string" && (
        <span className="text-zinc-400">
          {first ? ": " : ""}
          {second}
          {period}
        </span>
      )}{" "}
      <SourceLink url={url} />
      {extra.length > 0 && <span className="block text-xs text-zinc-500">Struggles: {extra.join("; ")}</span>}
    </span>
  );
}

function SourceChips({ ids, sourceMap }: { ids: string[]; sourceMap: Record<string, SourceRef> }) {
  const refs = ids.flatMap((id) => (sourceMap[id] ? [{ id, ref: sourceMap[id] }] : []));
  if (!refs.length) return <p className="text-xs text-zinc-600">No source found</p>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Sources">
      {refs.map(({ id, ref }) => {
        const internal = ref.origin === "owned_internal";
        const label = ref.title || id;
        return (
          <li key={id} className="rounded-full border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
            {!internal && ref.url && /^https?:\/\//i.test(ref.url) ? (
              <a href={ref.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-zinc-200">
                {label}
              </a>
            ) : (
              <span>{label}</span>
            )}
            {internal && <span className="ml-1 text-zinc-600">private — never quoted</span>}
          </li>
        );
      })}
    </ul>
  );
}

type Messaging = {
  oneLiners: string[];
  elevatorPitch: string;
  objections: { objection: string; answer: string }[];
  wordsToUse: string[];
  wordsToAvoid: string[];
};

function HowYouSound({ dna, messaging, ctx }: { dna: ProductDna; messaging: Messaging | null; ctx: Ctx }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-base font-semibold">How you sound</h3>
      <dl className="flex flex-col gap-5">
        <FieldRow path="identity.voice" value={dna.identity.voice} ctx={ctx} />
      </dl>
      {messaging && (
        <div className="flex flex-col gap-3 text-sm">
          {messaging.elevatorPitch && (
            <div>
              <p className="text-zinc-500">Your pitch in a few sentences</p>
              <p className="text-zinc-200">{messaging.elevatorPitch}</p>
            </div>
          )}
          {messaging.oneLiners.length > 0 && (
            <div>
              <p className="text-zinc-500">One-liners</p>
              <ValueView value={messaging.oneLiners} />
            </div>
          )}
          {messaging.objections.length > 0 && (
            <div>
              <p className="text-zinc-500">When people push back</p>
              <ul className="list-disc space-y-1 pl-5 text-zinc-200">
                {messaging.objections.map((o, i) => (
                  <li key={i}>
                    <span className="italic">&ldquo;{o.objection}&rdquo;</span> <span className="text-zinc-400">{o.answer}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function PublicFacts({ claims }: { claims: { id: string; text: string; kind: string }[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">Facts you can use in public</h3>
      <p className="text-xs text-zinc-500">Only these can appear in posts. Each one has a public source.</p>
      {claims.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-200">
          {claims.map((c) => (
            <li key={c.id}>{c.text}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500">None yet.</p>
      )}
    </section>
  );
}
