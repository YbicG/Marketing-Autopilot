import type { FetchLike } from "../core/http.ts";

/**
 * An in-memory Resend behind a FetchLike, for tests: createResend({ fetch: fake.fetch }). It follows
 * the documented shapes (see resend.ts) closely enough to exercise create → send → get → delete,
 * contact paging and unsubscribes.
 */

export interface FakeResendBroadcast {
  id: string;
  name: string;
  segmentId: string;
  from: string;
  subject: string;
  replyTo: string | null;
  html: string;
  text: string;
  status: "draft" | "scheduled" | "queued" | "sending" | "sent" | "canceled";
  scheduledAt: string | null;
  sentAt: string | null;
}

export interface FakeResendContact {
  id: string;
  email: string;
  unsubscribed: boolean;
  segmentId: string;
}

export interface FakeResend {
  fetch: FetchLike;
  broadcasts: Map<string, FakeResendBroadcast>;
  contacts: FakeResendContact[];
  segments: { id: string; name: string }[];
  calls: { method: string; path: string; body: unknown }[];
  /** Return a Response to override the next matching call (e.g. a 500), or undefined to pass through. */
  intercept: ((method: string, path: string, body: unknown) => Response | undefined) | null;
  addContacts(segmentId: string, emails: string[]): void;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fakeBroadcastSeq = 0;

export function fakeResend(opts: { pageSize?: number } = {}): FakeResend {
  let n = 0;
  const f: FakeResend = {
    broadcasts: new Map(),
    contacts: [],
    segments: [{ id: "seg_buyers", name: "Past buyers" }],
    calls: [],
    intercept: null,
    addContacts(segmentId, emails) {
      for (const email of emails) f.contacts.push({ id: `ct_${++n}`, email, unsubscribed: false, segmentId });
    },
    fetch: async (url, init) => {
      const u = new URL(url);
      const method = (init.method ?? "GET").toUpperCase();
      const body = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      f.calls.push({ method, path: u.pathname + u.search, body });
      const hit = f.intercept?.(method, u.pathname, body);
      if (hit) return hit;
      const auth = new Headers(init.headers as Record<string, string>).get("authorization");
      if (!auth?.startsWith("Bearer re_")) return json(401, { message: "API key is invalid" });
      const parts = u.pathname.split("/").filter(Boolean);

      if (parts[0] === "segments" && method === "GET") return json(200, { object: "list", has_more: false, data: f.segments });

      if (parts[0] === "broadcasts") {
        const id = parts[1];
        if (!id && method === "POST") {
          const b: FakeResendBroadcast = {
            id: `bc_${++fakeBroadcastSeq}`,
            name: String(body?.name ?? ""),
            segmentId: String(body?.segment_id ?? ""),
            from: String(body?.from ?? ""),
            subject: String(body?.subject ?? ""),
            replyTo: typeof body?.reply_to === "string" ? body.reply_to : null,
            html: String(body?.html ?? ""),
            text: String(body?.text ?? ""),
            status: "draft",
            scheduledAt: null,
            sentAt: null,
          };
          if (!b.segmentId || !b.from || !b.subject) return json(422, { message: "Missing required field" });
          f.broadcasts.set(b.id, b);
          return json(200, { object: "broadcast", id: b.id });
        }
        const b = id ? f.broadcasts.get(id) : undefined;
        if (!b) return json(404, { message: "Broadcast not found" });
        if (parts[2] === "send" && method === "POST") {
          if (b.status !== "draft") return json(422, { message: "Broadcast already sent or scheduled" });
          const at = typeof body?.scheduled_at === "string" ? body.scheduled_at : null;
          b.status = at ? "scheduled" : "queued";
          b.scheduledAt = at;
          return json(200, { id: b.id });
        }
        if (method === "GET") {
          return json(200, { object: "broadcast", id: b.id, name: b.name, segment_id: b.segmentId, status: b.status, scheduled_at: b.scheduledAt, sent_at: b.sentAt });
        }
        if (method === "DELETE") {
          if (b.status !== "draft" && b.status !== "scheduled") return json(422, { message: "Only draft or scheduled broadcasts can be deleted" });
          f.broadcasts.delete(b.id);
          return json(200, { object: "broadcast", id: b.id, deleted: true });
        }
      }

      if (parts[0] === "contacts") {
        if (!parts[1] && method === "GET") {
          const seg = u.searchParams.get("segment_id");
          const limit = Math.min(Number(u.searchParams.get("limit") ?? 20), opts.pageSize ?? 100);
          const after = u.searchParams.get("after");
          const all = f.contacts.filter((c) => !seg || c.segmentId === seg);
          const start = after ? all.findIndex((c) => c.id === after) + 1 : 0;
          const page = all.slice(start, start + limit);
          return json(200, {
            object: "list",
            has_more: start + limit < all.length,
            data: page.map((c) => ({ id: c.id, email: c.email, unsubscribed: c.unsubscribed })),
          });
        }
        if (parts[1] && method === "PATCH") {
          const key = decodeURIComponent(parts[1]);
          const c = f.contacts.find((x) => x.id === key || x.email === key);
          if (!c) return json(404, { message: "Contact not found" });
          if (typeof body?.unsubscribed === "boolean") c.unsubscribed = body.unsubscribed;
          return json(200, { object: "contact", id: c.id });
        }
      }
      return json(404, { message: "Not found" });
    },
  };
  return f;
}
