import { z } from "zod";
import { CAPTURE_LOGIN_RE, captureLoginPurpose, KNOWN_PURPOSES } from "@mkt/core/cost";
import { deleteSecret, putSecret, VaultKeyError } from "@mkt/core/security";
import { listProducts } from "@mkt/core/tenancy";
import { VAULT_KEY_MISSING } from "@/components/settings/vault";
import { getDb } from "@/lib/db";
import { isSameOrigin, json, sessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

const Purpose = z.string().min(1).max(120);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("put"), purpose: Purpose, value: z.string().trim().min(1).max(8_192) }),
  z.object({
    action: z.literal("put_login"),
    productId: z.uuid(),
    username: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1_024),
    loginPath: z
      .string()
      .trim()
      .max(300)
      .regex(/^\/(?!\/)/)
      .optional(),
  }),
  z.object({ action: z.literal("delete"), purpose: Purpose }),
]);

/**
 * Settings → Keys (§3.6 vault list). Only known purposes and this workspace's demo logins may be
 * written. Responses never echo a value; the page reads names and hints through listSecrets.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json(403, { error: "Cross-origin request refused." });
  const s = await sessionFromRequest(req);
  if (!s) return json(401, { error: "Please sign in." });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Something in the form is missing or too long. Check it and try again." });
  const b = parsed.data;
  const db = getDb();

  const ownsProduct = async (productId: string) => (await listProducts(db, s.workspaceId)).some((p) => p.id === productId);

  try {
    if (b.action === "put_login") {
      if (!(await ownsProduct(b.productId))) return json(404, { error: "That project doesn't exist any more. Refresh the page." });
      // The vault keeps the last 4 characters as a hint; a trailing version field keeps them from
      // being the tail of the password.
      const value = JSON.stringify({ username: b.username, password: b.password, ...(b.loginPath ? { loginPath: b.loginPath } : {}), v: 1 });
      await putSecret(db, s.workspaceId, captureLoginPurpose(b.productId), value);
      return json(200, { ok: true });
    }

    const login = CAPTURE_LOGIN_RE.exec(b.purpose);
    if (!KNOWN_PURPOSES.has(b.purpose) && !login) return json(400, { error: "That isn't a key this app uses." });
    if (login && b.action === "put") return json(400, { error: "Use the test login form for demo logins." });
    if (login && !(await ownsProduct(login[1]!))) return json(404, { error: "That project doesn't exist any more. Refresh the page." });

    if (b.action === "delete") {
      await deleteSecret(db, s.workspaceId, b.purpose);
      return json(200, { ok: true });
    }
    const { hint } = await putSecret(db, s.workspaceId, b.purpose, b.value);
    return json(200, { ok: true, hint });
  } catch (err) {
    if (err instanceof VaultKeyError) return json(409, { error: VAULT_KEY_MISSING });
    throw err;
  }
}
