// D26 / §8 capture-safety row: everything the demo recorder may click, type or request.
// Pure functions only; the worker's context.route and click-time checks call these.

import type { CaptureFlow, CaptureFlowStep, CaptureTarget } from "@mkt/contracts";
import { scanSecrets } from "../security/secret-scan.ts";

// ── Action denylist ──

/**
 * Whole words/phrases (case-insensitive) that must never be clicked or planned. Checked on the
 * button's text AND aria-label AND the plan step's text (§5.6 step 1). Err on the side of blocking:
 * a demo that skips a harmless "Share" is fine, one that pays or deletes is not.
 */
export const ACTION_DENYLIST = [
  "buy",
  "buy now",
  "pay",
  "pay now",
  "payment",
  "payments",
  "checkout",
  "check out",
  "purchase",
  "subscribe",
  "unsubscribe",
  "upgrade",
  "billing",
  "place order",
  "order now",
  "donate",
  "tip",
  "delete",
  "remove",
  "destroy",
  "erase",
  "wipe",
  "trash",
  "discard",
  "revoke",
  "deactivate",
  "close account",
  "reset",
  "send",
  "invite",
  "publish",
  "post",
  "share",
  "transfer",
  "withdraw",
  "cancel subscription",
  "cancel plan",
  "cancel membership",
  "approve",
  "log out",
  "logout",
  "sign out",
  "signout",
] as const;

const INVISIBLE = /[­​-‏⁠-⁤﻿]/g;

/** NFKC, invisible characters stripped, lowercase, one space between words. */
export function normalizeLabel(s: string): string {
  return s
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(/[_\-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest first so "cancel subscription" is reported rather than a shorter overlap.
const DENY_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[...ACTION_DENYLIST]
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRe(w).replace(/ /g, "\\s+"))
    .join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

/** The denylisted word in `s`, or null. */
export function deniedWord(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = DENY_RE.exec(normalizeLabel(s));
  return m ? m[1]!.replace(/\s+/g, " ") : null;
}

export type ActionCheck = { allowed: true } | { allowed: false; word: string; label: string };

/** Every label an element carries (text, aria-label, title, value…). One hit blocks the click. */
export function checkActionLabels(labels: readonly (string | null | undefined)[]): ActionCheck {
  for (const label of labels) {
    const word = deniedWord(label);
    if (word) return { allowed: false, word, label: String(label).slice(0, 120) };
  }
  return { allowed: true };
}

// ── Trusted origin (D26) ──

/**
 * Our own services (and Dokploy's) that share networks with the worker. A trusted origin naming one
 * of these would point the capture browser at internal infrastructure.
 */
const RESERVED_HOSTS = new Set([
  "localhost",
  "postgres",
  "redis",
  "web",
  "worker",
  "migrate",
  "smokescreen",
  "dokploy",
  "dokploy-postgres",
  "dokploy-redis",
  "dokploy-traefik",
  "traefik",
  "host",
  "gateway",
  "metadata",
  "docker",
]);

/** A Docker service name: lowercase letters, digits, "-" and "_", no dots (so never a public domain). */
const SERVICE_NAME = /^[a-z][a-z0-9_-]{0,62}$/;

export type TrustedOriginCheck = { ok: true; origin: string; host: string } | { ok: false; reason: string };

/**
 * The trusted origin is set by the owner in the UI and must be an internal Docker service:
 * `http(s)://<docker-service-name>:<port>`, nothing else (no path, query, user info or IP).
 */
export function validateTrustedOrigin(raw: string): TrustedOriginCheck {
  const s = raw.trim();
  const m = /^(https?):\/\/([^/:?#@\s]+):(\d{1,5})\/?$/i.exec(s);
  if (!m) {
    return { ok: false, reason: "Use the demo's internal address, like http://syllacal-demo:3000 (service name and port, nothing else)." };
  }
  const scheme = m[1]!.toLowerCase();
  const host = m[2]!;
  const port = Number(m[3]);
  if (host !== host.toLowerCase()) return { ok: false, reason: "The service name must be lowercase." };
  if (!SERVICE_NAME.test(host)) {
    return { ok: false, reason: "That isn't a Docker service name. Public sites and IP addresses can't be capture targets." };
  }
  if (RESERVED_HOSTS.has(host) || host.startsWith("dokploy")) {
    return { ok: false, reason: `"${host}" is one of the app's own services, not a demo site.` };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, reason: "The port must be between 1 and 65535." };
  return { ok: true, origin: `${scheme}://${host}:${port}`, host };
}

// ── Route denylist ──

/** Suggested capture_route_denylist for SyllaCal (§5.6): payments, the paid parse call, email. */
export const SYLLACAL_ROUTE_DENYLIST_SUGGESTION = [
  "/api/checkout",
  "/api/parse",
  "/api/stripe",
  "/api/webhooks",
  "/api/email",
  "/api/send",
  "/api/**/email*",
  "/api/**/send*",
] as const;

export type DenylistCheck = { ok: true; entries: string[] } | { ok: false; reason: string };

export function validateRouteDenylist(entries: readonly string[]): DenylistCheck {
  const out: string[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    if (!e.startsWith("/") || e.startsWith("//") || e.length > 200 || /[\s?#\\]/.test(e)) {
      return { ok: false, reason: `"${e.slice(0, 60)}" should be a path like /api/checkout (a * matches one part, ** any number).` };
    }
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > 100) return { ok: false, reason: "Keep the blocked list under 100 paths." };
  return { ok: true, entries: out };
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else re += escapeRe(c);
  }
  // A glob covers the path itself and anything below it.
  return new RegExp(`^${re}(?:/.*)?$`, "i");
}

function pathVariants(pathname: string): string[] {
  const collapse = (p: string) => p.replace(/\/{2,}/g, "/");
  const out = new Set([collapse(pathname)]);
  try {
    out.add(collapse(decodeURIComponent(pathname)));
  } catch {
    // a malformed escape is matched raw
  }
  return [...out];
}

/** Plain entries match as a case-insensitive prefix (so /api/checkout also blocks /api/checkout-session); globs match fully. */
export function matchesRouteDenylist(pathname: string, denylist: readonly string[]): string | null {
  for (const p of pathVariants(pathname)) {
    const lower = p.toLowerCase();
    for (const entry of denylist) {
      if (entry.includes("*") ? globToRegExp(entry).test(p) : lower.startsWith(entry.toLowerCase())) return entry;
    }
  }
  return null;
}

// ── Request guard (context.route) ──

/** Payment hosts, blocked always and first, whatever the origin (§5.6). */
export const PAYMENT_DOMAINS = [
  "stripe.com",
  "stripe.network",
  "stripecdn.com",
  "paypal.com",
  "paypalobjects.com",
  "braintreegateway.com",
  "braintree-api.com",
  "squareup.com",
  "squarecdn.com",
  "paddle.com",
  "paddle.net",
  "lemonsqueezy.com",
  "chargebee.com",
  "recurly.com",
  "adyen.com",
  "checkout.com",
  "klarna.com",
  "afterpay.com",
  "affirm.com",
  "gumroad.com",
  "fastspring.com",
  "2checkout.com",
  "razorpay.com",
  "mollie.com",
  "pay.google.com",
  "payments.google.com",
  "apple-pay-gateway.apple.com",
] as const;

/** First DNS labels that mean a payment host on any domain (checkout.example.com). */
const PAYMENT_LABELS = new Set(["checkout", "pay", "payment", "payments", "billing"]);

export function isPaymentHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (PAYMENT_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  const first = h.split(".")[0] ?? "";
  return h.includes(".") && PAYMENT_LABELS.has(first);
}

export interface RequestInfo {
  url: string;
  method: string;
  /** The validated trusted origin (validateTrustedOrigin().origin). */
  trustedOrigin: string;
  routeDenylist: readonly string[];
  /** Playwright's request.resourceType(), for the reason only. */
  resourceType?: string;
}

export type RequestDecision =
  | { allow: true }
  | {
      allow: false;
      reason: "bad_url" | "bad_origin" | "payment" | "off_origin" | "off_origin_write" | "route_denylist" | "risky_write" | "scheme";
      detail?: string;
    };

/**
 * Only the trusted origin and its own static assets load (plus data:/blob:). Payment hosts are
 * aborted first; non-GET requests off the origin are reported separately (the M3b done-when counts
 * them); any path on the route denylist is aborted whatever the method.
 */
export function isAllowedRequest(req: RequestInfo): RequestDecision {
  const trusted = validateTrustedOrigin(req.trustedOrigin);
  if (!trusted.ok) return { allow: false, reason: "bad_origin" };
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return { allow: false, reason: "bad_url" };
  }
  if (u.protocol === "data:" || u.protocol === "blob:") return { allow: true };
  if (u.protocol !== "http:" && u.protocol !== "https:") return { allow: false, reason: "scheme", detail: u.protocol };
  if (isPaymentHost(u.hostname)) return { allow: false, reason: "payment", detail: u.hostname };
  if (u.origin !== trusted.origin || u.username || u.password) {
    const write = !["GET", "HEAD"].includes(req.method.toUpperCase());
    return { allow: false, reason: write ? "off_origin_write" : "off_origin", detail: `${req.resourceType ?? "request"} ${u.host}` };
  }
  const hit = matchesRouteDenylist(u.pathname, req.routeDenylist);
  if (hit) return { allow: false, reason: "route_denylist", detail: hit };
  // Built in, whatever the owner's list says: DELETE never runs, and a write to a path that names a
  // denylisted action (/api/checkout, /courses/42/delete) is aborted.
  const method = req.method.toUpperCase();
  if (method === "DELETE") return { allow: false, reason: "risky_write", detail: "DELETE" };
  if (method !== "GET" && method !== "HEAD") {
    const word = pathVariants(u.pathname).map((p) => deniedWord(p.replace(/[/._-]+/g, " "))).find(Boolean);
    if (word) return { allow: false, reason: "risky_write", detail: word };
  }
  return { allow: true };
}

// ── Plan-time step screening ──

const SAFE_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "option",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "listitem",
  "row",
  "cell",
  "gridcell",
  "treeitem",
  "heading",
  "img",
]);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const LONG_DIGITS = /\d[\d\s-]{8,}\d/;

export function targetLabels(t: CaptureTarget): string[] {
  switch (t.by) {
    case "text":
      return [t.text];
    case "role":
      return [t.role, t.name];
    case "label":
      return [t.label];
    case "placeholder":
      return [t.placeholder];
    case "selector":
      return [t.selector];
  }
}

function stepTexts(step: CaptureFlowStep): string[] {
  const out = step.note ? [step.note] : [];
  switch (step.kind) {
    case "click":
    case "hover":
      out.push(...targetLabels(step.target));
      break;
    case "type":
      out.push(...targetLabels(step.field), step.text);
      break;
    case "goto":
      out.push(step.path.replace(/[/?&=#_.-]+/g, " "));
      break;
    case "pressKey":
      out.push(step.key);
      break;
  }
  return out;
}

export type StepScreen = { ok: true } | { ok: false; reason: string };

/** Plan/save-time check of one step (the click-time check in the recorder runs again on the live page). */
export function screenStep(step: CaptureFlowStep, routeDenylist: readonly string[] = []): StepScreen {
  for (const t of stepTexts(step)) {
    const word = deniedWord(t);
    if (word) return { ok: false, reason: `uses a blocked action ("${word}")` };
  }
  if (step.kind === "goto") {
    let u: URL;
    try {
      u = new URL(step.path, "http://capture-origin.invalid:1");
    } catch {
      return { ok: false, reason: "isn't a path on the demo site" };
    }
    if (u.origin !== "http://capture-origin.invalid:1") return { ok: false, reason: "leaves the demo site" };
    const hit = matchesRouteDenylist(u.pathname, routeDenylist);
    if (hit) return { ok: false, reason: `opens a blocked path (${hit})` };
  }
  const targets = step.kind === "click" || step.kind === "hover" ? [step.target] : step.kind === "type" ? [step.field] : [];
  for (const t of targets) {
    if (t.by === "role" && !SAFE_ROLES.has(t.role.toLowerCase())) return { ok: false, reason: `uses an unusual element role (${t.role})` };
    if (t.by === "selector" && /javascript:|url\(|<|>>|\bnth=|xpath|internal:/i.test(t.selector)) {
      return { ok: false, reason: "uses a selector the recorder doesn't allow" };
    }
  }
  if (step.kind === "type") {
    if (scanSecrets(step.text).hits.length) return { ok: false, reason: "would type something that looks like a secret" };
    if (EMAIL.test(step.text) || LONG_DIGITS.test(step.text)) {
      return { ok: false, reason: "would type an email address or a long number (possible personal data)" };
    }
  }
  return { ok: true };
}

const SUBMIT_WORDS = /(?<![\p{L}\p{N}])(submit|save|create|add|upload|import|continue|next|finish|done|confirm|apply|sign in|log in|login|sign up|register|generate|convert|sync|connect|export)(?![\p{L}\p{N}])/iu;

/**
 * Flows that log in or submit a form need one confirm click in the UI (§5.6). Typing anything,
 * pressing Enter, or clicking a submit-sounding button counts as submitting.
 */
export function flowNeedsConfirm(flow: Pick<CaptureFlow, "steps" | "needsLogin">): boolean {
  if (flow.needsLogin) return true;
  return flow.steps.some((s) => {
    if (s.kind === "type") return true;
    if (s.kind === "pressKey") return s.key === "Enter" || s.key === "Space";
    if (s.kind === "click") return targetLabels(s.target).some((l) => SUBMIT_WORDS.test(normalizeLabel(l)));
    return false;
  });
}

export interface FlowScreen {
  flow: CaptureFlow;
  dropped: { index: number; step: CaptureFlowStep; reason: string }[];
}

/** Drops blocked steps (plan time). The caller decides whether what's left is still worth recording. */
export function screenFlow(flow: CaptureFlow, routeDenylist: readonly string[] = []): FlowScreen {
  const dropped: FlowScreen["dropped"] = [];
  const steps: CaptureFlowStep[] = [];
  flow.steps.forEach((step, index) => {
    const r = screenStep(step, routeDenylist);
    if (r.ok) steps.push(step);
    else dropped.push({ index, step, reason: r.reason });
  });
  const nameWord = deniedWord(flow.name);
  if (nameWord) {
    const reason = `the flow is about a blocked action ("${nameWord}")`;
    return { flow: { ...flow, steps: [] }, dropped: flow.steps.map((step, index) => ({ index, step, reason })) };
  }
  return { flow: { ...flow, steps }, dropped };
}
