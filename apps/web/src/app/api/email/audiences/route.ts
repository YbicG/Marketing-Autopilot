import { resend } from "@mkt/providers";
import { json } from "@/lib/session";
import { productFor, readSession, resendCtx, resendErrorMessage } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Contacts counted at most this many pages of 100 deep, so a big list doesn't hold the request. */
const COUNT_PAGES = 10;

/**
 * The Resend lists (segments, or audiences on older accounts) for the sender settings picker.
 * With ?count=<id>, also how many contacts that list has (up to 1,000, then "1,000+").
 */
export async function GET(req: Request) {
  const auth = await readSession(req);
  if (!auth.ok) return auth.res;
  const url = new URL(req.url);
  const product = await productFor(auth.s.workspaceId, url.searchParams.get("slug"));
  if (!product) return json(404, { error: "Product not found." });
  const ctx = resendCtx(auth.s.workspaceId);
  try {
    const countId = url.searchParams.get("count");
    if (countId) {
      if (countId.length > 200) return json(400, { error: "Pick a list again." });
      let subscribed = 0;
      let unsubscribed = 0;
      let after: string | null = null;
      let more = false;
      for (let i = 0; i < COUNT_PAGES; i++) {
        const page = await resend.listContacts(ctx, countId, { after, limit: 100 });
        for (const c of page.contacts) {
          if (c.unsubscribed) unsubscribed++;
          else subscribed++;
        }
        more = page.hasMore;
        if (!page.hasMore || !page.next) break;
        after = page.next;
      }
      return json(200, { count: { subscribed, unsubscribed, more } });
    }
    const audiences = await resend.listAudiences(ctx);
    return json(200, { audiences: audiences.map((a) => ({ id: a.id, name: a.name })) });
  } catch (err) {
    return json(502, { error: resendErrorMessage(err) });
  }
}
