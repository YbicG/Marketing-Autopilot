import { AdsExportRefused } from "@mkt/core/ads";
import { KitNotReady } from "@mkt/core/launch";
import { json } from "@/lib/session";

// Shared by the launch kit routes. Not a route: no route.ts here.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The kit module throws plain `Error`s with sentences meant for the person (and KitNotReady /
 * AdsExportRefused); those become 400s. Anything else (a DB or storage failure) is logged and hidden.
 */
export function kitErrorResponse(err: unknown): Response {
  if (err instanceof KitNotReady || err instanceof AdsExportRefused || (err instanceof Error && err.constructor === Error)) {
    const m = err.message.trim();
    return json(400, { error: m.endsWith(".") || m.endsWith("?") ? m : `${m}.` });
  }
  console.error("[launch kit route]", err);
  return json(500, { error: "That didn't work. Try again in a minute." });
}
