import { z } from "zod";
import { mintPat, PAT_NAME_MAX, PAT_SCOPES, revokePat } from "@mkt/core/tools";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { requireUiSession } from "@/lib/ui-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().trim().min(1).max(PAT_NAME_MAX),
    scopes: z.array(z.enum(PAT_SCOPES)).min(1).max(PAT_SCOPES.length),
    expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
  }),
  z.object({ action: z.literal("revoke"), id: z.uuid() }),
]);

/**
 * Settings → Agent access (§9). Making and revoking tokens takes a person in the app (UI session:
 * cookie, our Origin, CSRF header); a token can't make another token. The new token is in this
 * response only, once; after that only its hash is kept.
 */
export async function POST(req: Request) {
  const g = await requireUiSession(req);
  if (!g.ok) return g.res;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Give the token a name and pick what it may do." });
  const body = parsed.data;
  const db = getDb();

  if (body.action === "revoke") {
    const ok = await revokePat(db, g.ui, body.id);
    return ok ? json(200, { ok: true }) : json(404, { error: "That token is gone or was already revoked." });
  }
  const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;
  try {
    const m = await mintPat(db, g.ui, { name: body.name, scopes: body.scopes, expiresAt });
    return Response.json({ id: m.id, token: m.token }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : "Couldn't make the token. Try again." });
  }
}
