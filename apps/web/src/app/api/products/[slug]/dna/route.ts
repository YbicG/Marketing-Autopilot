import { z } from "zod";
import { DNA_SECTIONS } from "@mkt/contracts";
import { confirmDna, editDnaField, productBySlug, setLaunchDate, setPinned } from "@mkt/core/ingest";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Path = z.string().regex(/^[a-z]+\.[A-Za-z]+$/).max(100);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), dnaVersionId: z.string().uuid(), path: Path, value: z.unknown() }),
  z.object({ action: z.literal("pin"), dnaVersionId: z.string().uuid(), path: Path, pinned: z.boolean() }),
  z.object({ action: z.literal("confirm"), dnaVersionId: z.string().uuid() }),
  z.object({ action: z.literal("launch_date"), strategyId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

type Checkable = { safeParse(v: unknown): { success: boolean } };

/** The zod schema for one top-level profile field ("identity.oneLiner"), so an edit can't break its shape. */
function fieldSchema(path: string): Checkable | null {
  const [section, key] = path.split(".");
  const sec = (DNA_SECTIONS as unknown as Record<string, { shape: Record<string, Checkable> } | undefined>)[section ?? ""];
  return (key && sec?.shape[key]) || null;
}

/** Plan screen edits: inline fixes, "Wrong?", pins, "These look right" and the launch date. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const { slug } = await ctx.params;
  const db = getDb();
  const product = await productBySlug(db, s.workspaceId, slug);
  if (!product) return json(404, { error: "Product not found." });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "That change didn't look right. Try again." });
  const body = parsed.data;

  if (body.action === "launch_date") {
    const strategy = await db.query.strategies.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, body.strategyId), eq(t.productId, product.id), eq(t.workspaceId, s.workspaceId)),
    });
    if (!strategy) return json(404, { error: "Plan not found." });
    const ok = await setLaunchDate(db, s.workspaceId, strategy.id, body.date);
    return ok ? json(200, { ok: true }) : json(400, { error: "Pick a real date." });
  }

  const version = await db.query.productDnaVersions.findFirst({
    where: (t, { and, eq }) => and(eq(t.id, body.dnaVersionId), eq(t.productId, product.id), eq(t.workspaceId, s.workspaceId)),
  });
  if (!version) return json(404, { error: "Profile not found." });

  switch (body.action) {
    case "confirm":
      await confirmDna(db, s.workspaceId, version.id);
      return json(200, { ok: true });
    case "pin": {
      const ok = await setPinned(db, s.workspaceId, version.id, body.path, body.pinned);
      return ok ? json(200, { ok: true }) : json(404, { error: "That field wasn't found." });
    }
    case "edit": {
      const schema = fieldSchema(body.path);
      if (!schema) return json(400, { error: "That field can't be changed." });
      if (!schema.safeParse(body.value).success) {
        return json(400, { error: "That value doesn't fit this field. Check the format and try again." });
      }
      try {
        await editDnaField(db, s.workspaceId, version.id, body.path, body.value);
      } catch {
        return json(400, { error: "That field can't be changed." });
      }
      return json(200, { ok: true });
    }
  }
}
