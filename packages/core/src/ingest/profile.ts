import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { DNA_SECTION_IDS, type ClaimKind, type DnaSectionId, type FieldMetaMap, type ProductDna } from "@mkt/contracts";
import { schema, uuidv7, type Db } from "@mkt/db";
import { workspacePrefix, type Storage } from "../media/storage.ts";
import { buildEvidenceBundle, claimIsPublic, type EvidenceBundle } from "./evidence.ts";
import { applyPins, mergeEvidence, type SectionResult } from "./merge-evidence.ts";
import { synthesizeSection, type CallCtx } from "./steps.ts";

const { sources, sourceArtifacts, researchItems, assets, dnaGapQuestions, productDnaVersions, claims, products } = schema;

/**
 * What one ingest run read about a product, as the evidence bundle. Same rows in → same ids out.
 * Answers and screenshots carry across runs; sources and research come from that run only.
 */
export async function loadEvidence(db: Db, productId: string, ingestRunId: string, productName: string): Promise<EvidenceBundle> {
  const arts = await db
    .select({
      artifactId: sourceArtifacts.id,
      sourceId: sourceArtifacts.sourceId,
      sourceKind: sources.kind,
      kind: sourceArtifacts.kind,
      title: sourceArtifacts.title,
      url: sourceArtifacts.url,
      path: sourceArtifacts.path,
      text: sourceArtifacts.text,
      visibility: sources.visibility,
    })
    .from(sourceArtifacts)
    .innerJoin(sources, eq(sources.id, sourceArtifacts.sourceId))
    .where(and(eq(sources.productId, productId), eq(sources.runId, ingestRunId), sql`${sourceArtifacts.kind} <> 'brand'`));

  const research = await db
    .select()
    .from(researchItems)
    .where(and(eq(researchItems.productId, productId), eq(researchItems.runId, ingestRunId)));

  const shots = await db.select().from(assets).where(eq(assets.productId, productId));
  const answered = await db
    .select({ question: dnaGapQuestions.question, answer: dnaGapQuestions.answer })
    .from(dnaGapQuestions)
    .where(and(eq(dnaGapQuestions.productId, productId), isNotNull(dnaGapQuestions.answer)));

  return buildEvidenceBundle({
    productName,
    artifacts: arts,
    research: research.map((r) => ({
      id: r.id,
      kind: r.kind,
      text: researchText(r.kind, r.data),
      sourceUrl: r.sourceUrl,
    })),
    assets: shots.map((a) => {
      const l = (a.labels ?? {}) as { caption?: string; kind?: string; visibleText?: string; usefulForMarketing?: boolean; hasPersonalData?: boolean };
      return {
        assetId: a.id,
        caption: l.hasPersonalData ? `${l.caption ?? ""} (shows personal data: don't use)` : (l.caption ?? null),
        kind: l.kind ?? null,
        pageUrl: typeof a.origination.pageUrl === "string" ? a.origination.pageUrl : null,
        visibleText: l.visibleText ?? null,
      };
    }),
    answers: answered.map((a) => ({ question: a.question, answer: a.answer! })),
  });
}

function researchText(kind: string, data: Record<string, unknown>): string {
  const s = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : "");
  if (kind === "competitor") {
    return [`${s("name")}${s("url") ? ` (${s("url")})` : ""}: ${s("summary")}`, s("pricing") && `Pricing: ${s("pricing")}`].filter(Boolean).join(" ");
  }
  if (kind === "pain") return `${s("text")}${s("audience") ? ` [${s("audience")}]` : ""}`;
  return `${s("kind") ? `${s("kind")}: ` : ""}${s("text")}${s("quote") ? ` "${s("quote")}"` : ""}`;
}

export interface BuiltClaim {
  ref: string;
  kind: ClaimKind;
  text: string;
  quote: string | null;
  sourceRefs: string[];
  publicOk: boolean;
  expiresAt: Date | null;
}

const COMPETITOR_FACT_DAYS = 30;

/**
 * Claims are the only statements generators may make about numbers, prices and comparisons (§5.0).
 * Each inherits visibility from what backs it: see `claimIsPublic`.
 */
export function buildClaims(dna: ProductDna, fields: FieldMetaMap, bundle: Pick<EvidenceBundle, "sourceMap" | "texts">, now: Date): BuiltClaim[] {
  const out: BuiltClaim[] = [];
  const add = (kind: ClaimKind, text: string, quote: string | null, sourceIds: string[]) => {
    const refs = sourceIds.filter((id) => bundle.sourceMap[id]);
    if (!text.trim() || refs.length === 0) return;
    out.push({
      ref: `C${out.length + 1}`,
      kind,
      text: text.trim(),
      quote,
      sourceRefs: refs,
      publicOk: claimIsPublic({ kind, text, quote, sourceIds: refs }, bundle),
      expiresAt: kind === "comparison" ? new Date(now.getTime() + COMPETITOR_FACT_DAYS * 86_400_000) : null,
    });
  };
  for (const p of dna.offer.proof) add(p.kind, p.text, p.quote, p.sourceIds);
  const pricing = fields["offer.pricing"];
  for (const t of dna.offer.pricing.tiers) {
    add("price", `${t.name}: ${t.price}${t.period ? ` ${t.period}` : ""}`, null, pricing?.sources ?? []);
  }
  return out;
}

export async function storeEvidence(store: Storage, workspaceId: string, productId: string, version: number, markdown: string): Promise<string> {
  const key = `${workspacePrefix(workspaceId)}/products/${productId.toLowerCase()}/dna/${version}/evidence.md`;
  await store.put(key, new TextEncoder().encode(markdown));
  return key;
}

export interface ProfileResult {
  dnaVersionId: string;
  version: number;
  coveragePct: number;
  claimCount: number;
  publicClaimCount: number;
  dna: ProductDna;
}

/**
 * Synthesize → merge evidence → keep pins → store a new draft DNA version with its claims. Used by the
 * ingest run and by "Regenerate profile" (dna_regenerate).
 */
export async function writeProfile(
  db: Db,
  store: Storage,
  ctx: CallCtx,
  product: { id: string; name: string; workspaceId: string },
  ingestRunId: string,
  now: Date,
  onSection?: (section: DnaSectionId) => Promise<unknown>,
): Promise<ProfileResult> {
  const bundle = await loadEvidence(db, product.id, ingestRunId, product.name);
  const results = await Promise.all(
    DNA_SECTION_IDS.map(async (s) => {
      const r = await synthesizeSection(ctx, s, bundle.markdown);
      await onSection?.(s);
      return [s, r] as const;
    }),
  );
  const sections = Object.fromEntries(results) as Record<DnaSectionId, SectionResult>;
  const merged = mergeEvidence(sections, new Set(Object.keys(bundle.sourceMap)));

  const [prev] = await db
    .select()
    .from(productDnaVersions)
    .where(eq(productDnaVersions.productId, product.id))
    .orderBy(desc(productDnaVersions.version))
    .limit(1);
  const pinned = applyPins(
    merged,
    prev ? { dna: prev.dna as unknown as ProductDna, fields: prev.fields as unknown as FieldMetaMap } : null,
  );
  const version = (prev?.version ?? 0) + 1;
  const evidenceKey = await storeEvidence(store, product.workspaceId, product.id, version, bundle.markdown);
  const built = buildClaims(pinned.dna, pinned.fields, bundle, now);

  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(productDnaVersions).values({
      id,
      workspaceId: product.workspaceId,
      productId: product.id,
      // The ingest run whose sources this version read; a regenerate re-reads the same ones.
      runId: ingestRunId,
      version,
      status: "draft",
      dna: pinned.dna as unknown as Record<string, unknown>,
      fields: pinned.fields,
      sourceMap: bundle.sourceMap as unknown as Record<string, unknown>,
      evidenceKey,
      coveragePct: merged.coveragePct,
    });
    if (built.length) {
      await tx.insert(claims).values(
        built.map((c) => ({
          id: uuidv7(),
          workspaceId: product.workspaceId,
          productId: product.id,
          dnaVersionId: id,
          ref: c.ref,
          kind: c.kind,
          text: c.text,
          quote: c.quote,
          sourceRefs: c.sourceRefs,
          publicOk: c.publicOk,
          expiresAt: c.expiresAt,
        })),
      );
    }
    await tx.update(products).set({ currentDnaVersionId: id }).where(eq(products.id, product.id));
  });

  return {
    dnaVersionId: id,
    version,
    coveragePct: merged.coveragePct,
    claimCount: built.length,
    publicClaimCount: built.filter((c) => c.publicOk).length,
    dna: pinned.dna,
  };
}

export async function claimsFor(db: Db, dnaVersionId: string) {
  return db.select().from(claims).where(eq(claims.dnaVersionId, dnaVersionId)).orderBy(claims.ref);
}

export async function assetsFor(db: Db, productId: string, ids?: string[]) {
  return db
    .select()
    .from(assets)
    .where(ids ? and(eq(assets.productId, productId), inArray(assets.id, ids)) : eq(assets.productId, productId));
}
