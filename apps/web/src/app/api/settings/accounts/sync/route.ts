import { profileUsername, SECRET_API_KEY } from "@mkt/providers";
import { listProducts, syncConnections } from "@mkt/core/tenancy";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";
import { uploadPostError, uploadPostFor } from "../upload-post";

export const dynamic = "force-dynamic";

/**
 * Back from a hosted connect link (or "Refresh accounts"): ask Upload-Post which accounts each
 * project's profile has and upsert social_connections. The redirect doesn't say which project, so
 * every active project is read (there are at most a few).
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const db = getDb();
  const { adapter, ctx } = uploadPostFor(s.workspaceId);
  try {
    if (!(await ctx.secret(SECRET_API_KEY))) return json(400, { error: "Add your Upload-Post API key first (step 1)." });
  } catch (err) {
    return json(502, { error: uploadPostError(err) });
  }

  let accounts = 0;
  const problems: string[] = [];
  for (const p of (await listProducts(db, s.workspaceId)).filter((x) => x.status === "active")) {
    const profileRef = profileUsername(p.slug); // what ensureProfile returned when it was made
    try {
      const health = await adapter.health(ctx, profileRef);
      const r = await syncConnections(db, s.workspaceId, { productId: p.id, publisher: "upload_post", profileRef, health });
      accounts += r.upserted;
    } catch (err) {
      problems.push(`${p.name}: ${uploadPostError(err)}`);
    }
  }
  if (problems.length && !accounts) return json(502, { error: problems.join(" ") });
  return json(200, { accounts, problems });
}
