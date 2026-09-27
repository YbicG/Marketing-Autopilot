import { BroadcastSettings } from "@mkt/contracts";
import { saveEmailSettings } from "@mkt/core/email";
import { getDb } from "@/lib/db";
import { json } from "@/lib/session";
import { answer, productFor, readBody, userActor, writeSession } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Plain sentences per field, instead of zod's wording. */
const FIELD_ERROR: Record<string, string> = {
  fromName: "Add the name people see it's from (up to 80 characters).",
  fromEmail: "The from address doesn't look like an email address.",
  replyTo: "The reply-to address doesn't look like an email address.",
  postalAddress: "Add a full postal address (the law needs one in every email).",
  audienceId: "Pick a Resend list again.",
  audienceLabel: "The list name is too long.",
  consentSource: "Say in a few words where these contacts came from (up to 300 characters).",
  euConsentAck: "Tick or untick the EU/UK box again.",
};

const opt = (v: unknown) => (typeof v === "string" ? v.trim() || undefined : undefined);

/**
 * Sender settings for one product (products.email_settings). Changing them sends approved or
 * scheduled broadcasts back for approval (and cancels them at Resend), because the sender and
 * footer are part of what was approved.
 */
export async function POST(req: Request) {
  const auth = await writeSession(req);
  if (!auth.ok) return auth.res;
  const body = await readBody(req);
  const product = await productFor(auth.s.workspaceId, body.slug);
  if (!product) return json(404, { error: "Product not found." });
  const raw = (body.settings && typeof body.settings === "object" ? body.settings : {}) as Record<string, unknown>;
  const input = {
    fromName: typeof raw.fromName === "string" ? raw.fromName.trim() : "",
    fromEmail: typeof raw.fromEmail === "string" ? raw.fromEmail.trim() : "",
    replyTo: opt(raw.replyTo),
    postalAddress: typeof raw.postalAddress === "string" ? raw.postalAddress.trim() : "",
    audienceId: opt(raw.audienceId),
    audienceLabel: opt(raw.audienceLabel),
    consentSource: opt(raw.consentSource),
    euConsentAck: raw.euConsentAck === true,
  };
  const parsed = BroadcastSettings.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")))];
    return json(400, { error: fields.map((f) => FIELD_ERROR[f] ?? "Check the sender details and try again.").join(" ") });
  }
  const r = await saveEmailSettings(getDb(), auth.s.workspaceId, product.id, parsed.data, userActor(auth.s.userId));
  return answer(r, (x) => ({ settings: x.settings }));
}
