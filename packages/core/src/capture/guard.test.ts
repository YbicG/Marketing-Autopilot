import { describe, expect, it } from "vitest";
import type { CaptureFlow, CaptureFlowStep } from "@mkt/contracts";
import {
  checkActionLabels,
  deniedWord,
  flowNeedsConfirm,
  isAllowedRequest,
  isPaymentHost,
  matchesRouteDenylist,
  screenFlow,
  screenStep,
  SYLLACAL_ROUTE_DENYLIST_SUGGESTION,
  validateRouteDenylist,
  validateTrustedOrigin,
} from "./guard.ts";

const ORIGIN = "http://syllacal-demo:3000";
const DENY = [...SYLLACAL_ROUTE_DENYLIST_SUGGESTION];
const req = (url: string, method = "GET", resourceType = "fetch") =>
  isAllowedRequest({ url, method, trustedOrigin: ORIGIN, routeDenylist: DENY, resourceType });

describe("action denylist", () => {
  it.each([
    ["Buy", "buy"],
    ["BUY NOW", "buy now"],
    ["Pay $4.99", "pay"],
    ["Checkout", "checkout"],
    ["Check out", "check out"],
    ["Complete purchase", "purchase"],
    ["Subscribe", "subscribe"],
    ["Delete semester", "delete"],
    ["Remove", "remove"],
    ["Destroy", "destroy"],
    ["Send", "send"],
    ["Send email", "send"],
    ["Invite a friend", "invite"],
    ["Publish", "publish"],
    ["Post", "post"],
    ["Share", "share"],
    ["Transfer", "transfer"],
    ["Cancel subscription", "cancel subscription"],
    ["cancel   SUBSCRIPTION", "cancel subscription"],
    ["Log out", "log out"],
    ["delete-account", "delete"],
    ["B​uy", "buy"],
    ["ＢＵＹ", "buy"],
    ["Approve and schedule everything", "approve"],
  ])("%s is blocked", (label, word) => {
    expect(deniedWord(label)).toBe(word);
  });

  it.each(["Posts", "Payday", "Removed items view", "Sender info", "Shared calendars", "Buyer guide", "Deleted", "Open calendar", "Add course", "Tooltip", "Sendgrid"])(
    "%s is a whole-word miss",
    (label) => {
      expect(deniedWord(label)).toBeNull();
    },
  );

  it("checks aria-label even when the visible text is harmless", () => {
    expect(checkActionLabels(["", "Delete account"])).toEqual({ allowed: false, word: "delete", label: "Delete account" });
    expect(checkActionLabels(["🗑", null, "Trash"])).toMatchObject({ allowed: false, word: "trash" });
    expect(checkActionLabels(["Open", "Open the calendar", undefined])).toEqual({ allowed: true });
  });
});

describe("trusted origin format", () => {
  it.each(["http://syllacal-demo:3000", "https://syllacal_demo:8443", "http://syllacal-demo:3000/"])("%s is accepted", (o) => {
    const r = validateTrustedOrigin(o);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.origin).toBe(o.replace(/\/$/, ""));
  });

  it.each([
    "https://syllacal.com",
    "https://syllacal.com:443",
    "http://syllacal-demo",
    "http://10.0.1.5:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "http://2130706433:80",
    "http://localhost:3000",
    "http://postgres:5432",
    "http://redis:6379",
    "http://smokescreen:4750",
    "http://web:3000",
    "http://dokploy-traefik:80",
    "http://Syllacal-Demo:3000",
    "http://syllacal-demo:3000/app",
    "http://syllacal-demo:3000?x=1",
    "http://user:pw@syllacal-demo:3000",
    "http://syllacal-demo:99999",
    "ftp://syllacal-demo:21",
    "javascript:alert(1)",
    "",
  ])("%s is rejected", (o) => {
    expect(validateTrustedOrigin(o).ok).toBe(false);
  });
});

describe("request guard", () => {
  it("allows the origin's pages and static assets, and data:/blob:", () => {
    expect(req(`${ORIGIN}/`, "GET", "document")).toEqual({ allow: true });
    expect(req(`${ORIGIN}/_next/static/chunks/main.js`, "GET", "script")).toEqual({ allow: true });
    expect(req(`${ORIGIN}/fonts/inter.woff2`, "GET", "font")).toEqual({ allow: true });
    expect(req("data:image/png;base64,AAAA", "GET", "image")).toEqual({ allow: true });
    expect(req("blob:http://syllacal-demo:3000/0b9f", "GET", "media")).toEqual({ allow: true });
  });

  it("allows same-origin writes that aren't on the denylist", () => {
    expect(req(`${ORIGIN}/api/courses`, "POST")).toEqual({ allow: true });
  });

  it("aborts every off-origin request, and flags non-GET ones", () => {
    expect(req("https://fonts.googleapis.com/css2?family=Inter", "GET", "stylesheet")).toMatchObject({ allow: false, reason: "off_origin" });
    expect(req("https://api.segment.io/v1/t", "POST")).toMatchObject({ allow: false, reason: "off_origin_write" });
    expect(req("https://syllacal.com/api/courses", "PUT")).toMatchObject({ allow: false, reason: "off_origin_write" });
    expect(req("http://syllacal-demo:3001/", "GET")).toMatchObject({ allow: false, reason: "off_origin" });
    expect(req("https://syllacal-demo:3000/", "GET")).toMatchObject({ allow: false, reason: "off_origin" });
    expect(req("http://user@syllacal-demo:3000/", "GET")).toMatchObject({ allow: false, reason: "off_origin" });
    expect(req("http://postgres:5432/", "GET")).toMatchObject({ allow: false, reason: "off_origin" });
  });

  it("aborts payment domains first", () => {
    for (const u of [
      "https://js.stripe.com/v3/",
      "https://checkout.stripe.com/c/pay/cs_test",
      "https://www.paypal.com/sdk/js",
      "https://checkout.example.com/",
      "https://pay.google.com/gp/p/js/pay.js",
      "https://api.lemonsqueezy.com/v1/checkouts",
    ]) {
      expect(req(u)).toMatchObject({ allow: false, reason: "payment" });
    }
    expect(isPaymentHost("stripe.com")).toBe(true);
    expect(isPaymentHost("notstripe.com")).toBe(false);
    expect(isPaymentHost("syllacal-demo")).toBe(false);
  });

  it("aborts route-denylisted paths on the origin, whatever the method", () => {
    expect(req(`${ORIGIN}/api/checkout`, "POST")).toMatchObject({ allow: false, reason: "route_denylist", detail: "/api/checkout" });
    expect(req(`${ORIGIN}/api/checkout/session`, "GET")).toMatchObject({ allow: false, reason: "route_denylist" });
    expect(req(`${ORIGIN}/api/checkout-session`, "POST")).toMatchObject({ allow: false, reason: "route_denylist" });
    expect(req(`${ORIGIN}/API/Parse`, "POST")).toMatchObject({ allow: false, reason: "route_denylist" });
    expect(req(`${ORIGIN}//api/parse`, "POST")).toMatchObject({ allow: false, reason: "route_denylist" });
    expect(req(`${ORIGIN}/api/%63heckout`, "POST")).toMatchObject({ allow: false, reason: "route_denylist" });
    expect(req(`${ORIGIN}/api/users/42/email-reminders`, "POST")).toMatchObject({ allow: false, reason: "route_denylist" });
    expect(req(`${ORIGIN}/api/courses`, "GET")).toEqual({ allow: true });
  });

  it("aborts DELETE and writes to action-named paths even with an empty denylist", () => {
    const bare = (url: string, method: string) => isAllowedRequest({ url, method, trustedOrigin: ORIGIN, routeDenylist: [] });
    expect(bare(`${ORIGIN}/api/courses/42`, "DELETE")).toMatchObject({ allow: false, reason: "risky_write" });
    expect(bare(`${ORIGIN}/api/checkout`, "POST")).toMatchObject({ allow: false, reason: "risky_write", detail: "checkout" });
    expect(bare(`${ORIGIN}/api/courses/42/delete`, "POST")).toMatchObject({ allow: false, reason: "risky_write" });
    expect(bare(`${ORIGIN}/api/invite_friends`, "PUT")).toMatchObject({ allow: false, reason: "risky_write" });
    expect(bare(`${ORIGIN}/api/checkout`, "GET")).toEqual({ allow: true });
    expect(bare(`${ORIGIN}/api/posts`, "POST")).toEqual({ allow: true });
  });

  it("denies everything when the origin itself is invalid", () => {
    expect(isAllowedRequest({ url: "https://syllacal.com/", method: "GET", trustedOrigin: "https://syllacal.com", routeDenylist: [] })).toMatchObject({
      allow: false,
      reason: "bad_origin",
    });
  });

  it("rejects odd schemes", () => {
    expect(req("file:///etc/passwd")).toMatchObject({ allow: false, reason: "scheme" });
    expect(req("not a url")).toMatchObject({ allow: false, reason: "bad_url" });
  });
});

describe("route denylist", () => {
  it("globs: * is one part, ** any depth", () => {
    expect(matchesRouteDenylist("/api/a/email", ["/api/*/email"])).toBe("/api/*/email");
    expect(matchesRouteDenylist("/api/a/b/email", ["/api/*/email"])).toBeNull();
    expect(matchesRouteDenylist("/api/a/b/email", ["/api/**/email"])).toBe("/api/**/email");
    expect(matchesRouteDenylist("/api/a/email/x", ["/api/*/email"])).toBe("/api/*/email");
  });

  it("validates entries", () => {
    expect(validateRouteDenylist(["/api/checkout", " /api/parse ", "", "/api/checkout"])).toEqual({ ok: true, entries: ["/api/checkout", "/api/parse"] });
    expect(validateRouteDenylist(["api/checkout"]).ok).toBe(false);
    expect(validateRouteDenylist(["//evil"]).ok).toBe(false);
    expect(validateRouteDenylist(["/a b"]).ok).toBe(false);
  });
});

describe("plan-time step screening", () => {
  const ok = (s: CaptureFlowStep) => expect(screenStep(s, DENY)).toEqual({ ok: true });
  const blocked = (s: CaptureFlowStep) => expect(screenStep(s, DENY).ok).toBe(false);

  it("passes ordinary demo steps", () => {
    ok({ kind: "goto", path: "/dashboard" });
    ok({ kind: "click", target: { by: "text", text: "Upload syllabus" }, note: "Start an upload" });
    ok({ kind: "click", target: { by: "role", role: "tab", name: "Week view" } });
    ok({ kind: "type", field: { by: "label", label: "Course name" }, text: "BIO 101" });
    ok({ kind: "scroll", direction: "down", amountPx: 600 });
    ok({ kind: "pressKey", key: "Enter" });
  });

  it("blocks denylisted words in targets, notes, selectors and paths", () => {
    blocked({ kind: "click", target: { by: "text", text: "Buy Pro" } });
    blocked({ kind: "click", target: { by: "role", role: "button", name: "Delete" } });
    blocked({ kind: "click", target: { by: "selector", selector: "#send-btn" } });
    blocked({ kind: "click", target: { by: "text", text: "Continue" }, note: "then pay for the plan" });
    blocked({ kind: "goto", path: "/billing" });
    blocked({ kind: "goto", path: "/settings/delete-account" });
    blocked({ kind: "hover", target: { by: "text", text: "Share" } });
  });

  it("blocks route-denylisted paths and weird selectors/roles", () => {
    blocked({ kind: "goto", path: "/api/parse" });
    blocked({ kind: "click", target: { by: "selector", selector: "a[href='javascript:void(0)']" } });
    blocked({ kind: "click", target: { by: "role", role: "application", name: "x" } });
  });

  it("never types secrets or personal data", () => {
    blocked({ kind: "type", field: { by: "label", label: "Key" }, text: "API_KEY=q7Zr4Xk2Lp9Vw3Ns8Tb6Yh1Jd5Fm0Gc" });
    blocked({ kind: "type", field: { by: "label", label: "Email" }, text: "someone@gmail.com" });
    blocked({ kind: "type", field: { by: "label", label: "Phone" }, text: "415 555 0199" });
  });

  it("screenFlow drops blocked steps and keeps the rest", () => {
    const flow: CaptureFlow = {
      name: "Upload a syllabus",
      needsLogin: false,
      steps: [
        { kind: "goto", path: "/" },
        { kind: "click", target: { by: "text", text: "Buy now" } },
        { kind: "click", target: { by: "text", text: "Upload" } },
      ],
    };
    const r = screenFlow(flow, DENY);
    expect(r.flow.steps).toHaveLength(2);
    expect(r.dropped).toEqual([expect.objectContaining({ index: 1 })]);
    expect(screenFlow({ ...flow, name: "Delete a semester" }, DENY).flow.steps).toHaveLength(0);
  });
});

describe("confirm rule", () => {
  const base = { needsLogin: false, steps: [{ kind: "goto", path: "/" }] as CaptureFlowStep[] };
  it("login, typing, Enter and submit-sounding clicks need a confirm click", () => {
    expect(flowNeedsConfirm(base)).toBe(false);
    expect(flowNeedsConfirm({ ...base, needsLogin: true })).toBe(true);
    expect(flowNeedsConfirm({ ...base, steps: [{ kind: "type", field: { by: "label", label: "Course" }, text: "BIO" }] })).toBe(true);
    expect(flowNeedsConfirm({ ...base, steps: [{ kind: "pressKey", key: "Enter" }] })).toBe(true);
    expect(flowNeedsConfirm({ ...base, steps: [{ kind: "click", target: { by: "text", text: "Save" } }] })).toBe(true);
    expect(flowNeedsConfirm({ ...base, steps: [{ kind: "click", target: { by: "text", text: "Week view" } }] })).toBe(false);
  });
});
