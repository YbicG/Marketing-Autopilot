// §8 "Capture safety" (§5.6, D26): the capture browser only reaches the owner's internal demo
// service; payment hosts, off-origin writes, denylisted routes, DELETE and risky writes are aborted;
// blocked words never get clicked; flows that log in or fill a form wait for one confirm click.
// The live checks run in apps/worker/src/capture/demo/recorder.ts:198 and :297, which call these.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { confirmFlow, createFlow, CaptureFlowError, flowBlocker, getFlow, setTrustedOrigin, updateFlow } from "../capture/flows.ts";
import { checkActionLabels, flowNeedsConfirm, isAllowedRequest, screenFlow, screenStep, validateTrustedOrigin } from "../capture/guard.ts";
import { seedWorkspace } from "../publishing/test-fixtures.ts";
import { sessionFor } from "./harness.ts";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const ORIGIN = "http://syllacal-demo:3000";
const req = (url: string, method = "GET", routeDenylist: string[] = ["/api/checkout", "/api/**/send*"]) => isAllowedRequest({ url, method, trustedOrigin: ORIGIN, routeDenylist });
const reason = (d: ReturnType<typeof isAllowedRequest>) => (d.allow ? "allowed" : d.reason);

describe("§8 Capture safety: what the capture browser may load", () => {
  it("only the trusted demo origin loads; payment hosts and off-origin writes are aborted", () => {
    expect(reason(req(`${ORIGIN}/courses`))).toBe("allowed");
    expect(reason(req("data:image/png;base64,AAAA"))).toBe("allowed");
    expect(reason(req("https://js.stripe.com/v3"))).toBe("payment");
    expect(reason(req("https://checkout.example.com/x"))).toBe("payment");
    expect(reason(req("https://evil.example.com/collect", "POST"))).toBe("off_origin_write");
    expect(reason(req("https://cdn.example.com/lib.js"))).toBe("off_origin");
    expect(reason(req("http://user:pw@syllacal-demo:3000/"))).toBe("off_origin");
    expect(reason(req("file:///etc/passwd"))).toBe("scheme");
  });

  it("denylisted routes are aborted whatever the method; DELETE and risky writes always are", () => {
    expect(reason(req(`${ORIGIN}/api/checkout/session`))).toBe("route_denylist");
    expect(reason(req(`${ORIGIN}/api/users/42/send-invite`, "POST"))).toBe("route_denylist");
    expect(reason(req(`${ORIGIN}/api/courses/42`, "DELETE", []))).toBe("risky_write");
    expect(reason(req(`${ORIGIN}/courses/42/delete`, "POST", []))).toBe("risky_write");
    expect(reason(req(`${ORIGIN}/courses/42/delete`, "GET", []))).toBe("allowed");
  });

  it("the trusted origin must be an internal service name, never a public site, IP or one of our own services", () => {
    expect(validateTrustedOrigin(ORIGIN)).toMatchObject({ ok: true, origin: ORIGIN });
    for (const bad of ["https://syllacal.com", "http://10.0.0.5:3000", "http://postgres:5432", "http://dokploy-traefik:80", "http://localhost:3000", "http://demo:3000/path"]) {
      expect(validateTrustedOrigin(bad).ok).toBe(false);
    }
    expect(reason(isAllowedRequest({ url: "http://postgres:5432/", method: "GET", trustedOrigin: "http://postgres:5432", routeDenylist: [] }))).toBe("bad_origin");
  });

  it("setTrustedOrigin refuses a bad origin before saving", async () => {
    const s = await seedWorkspace(db);
    await expect(setTrustedOrigin(db, sessionFor(s), s.productId, "http://169.254.169.254:80", [])).rejects.toBeInstanceOf(CaptureFlowError);
    expect(await setTrustedOrigin(db, sessionFor(s), s.productId, `${ORIGIN}/`, ["/api/checkout"])).toEqual({ origin: ORIGIN, denylist: ["/api/checkout"] });
  });
});

describe("§8 Capture safety: steps and clicks", () => {
  it("a click on a blocked word is refused, including hidden labels", () => {
    expect(checkActionLabels(["Open calendar"])).toEqual({ allowed: true });
    expect(checkActionLabels(["Go", "Buy now"])).toMatchObject({ allowed: false, word: "buy now" });
    expect(checkActionLabels([null, "  Delete   course "])).toMatchObject({ allowed: false, word: "delete" });
  });

  it("plan-time screening drops blocked words, off-site paths, secrets and personal data", () => {
    const blocked = (s: Parameters<typeof screenStep>[0]) => screenStep(s, ["/api/parse"]).ok === false;
    expect(blocked({ kind: "click", target: { by: "text", text: "Upgrade plan" } })).toBe(true);
    expect(blocked({ kind: "goto", path: "//evil.example.com/x" })).toBe(true);
    expect(blocked({ kind: "goto", path: "/api/parse" })).toBe(true);
    expect(blocked({ kind: "type", field: { by: "label", label: "Note" }, text: "ghp" + "_" + "a".repeat(36) })).toBe(true);
    expect(blocked({ kind: "type", field: { by: "label", label: "Email" }, text: "maya@example.com" })).toBe(true);
    expect(blocked({ kind: "type", field: { by: "label", label: "Phone" }, text: "555 123 4567" })).toBe(true);
    expect(blocked({ kind: "click", target: { by: "selector", selector: "a[href='javascript:alert(1)']" } })).toBe(true);
    expect(blocked({ kind: "click", target: { by: "text", text: "Open calendar" } })).toBe(false);
    // A flow named for a blocked action loses every step.
    const f = screenFlow({ name: "Cancel subscription", needsLogin: false, steps: [{ kind: "goto", path: "/settings" }] });
    expect(f.flow.steps).toEqual([]);
  });

  it("saving a flow with a blocked step is refused", async () => {
    const s = await seedWorkspace(db);
    await expect(createFlow(db, s.workspaceId, s.productId, { name: "Bad", needsLogin: false, steps: [{ kind: "click", target: { by: "text", text: "Delete" } }] })).rejects.toMatchObject({ code: "blocked" });
  });

  it("a flow that logs in or fills a form waits for one confirm click; any edit voids it", async () => {
    expect(flowNeedsConfirm({ needsLogin: false, steps: [{ kind: "goto", path: "/" }] })).toBe(false);
    expect(flowNeedsConfirm({ needsLogin: true, steps: [{ kind: "goto", path: "/" }] })).toBe(true);
    expect(flowNeedsConfirm({ needsLogin: false, steps: [{ kind: "click", target: { by: "text", text: "Save course" } }] })).toBe(true);

    const s = await seedWorkspace(db);
    const input = { name: "Add a course", needsLogin: false, steps: [{ kind: "type" as const, field: { by: "label" as const, label: "Course name" }, text: "BIO 101" }] };
    const id = await createFlow(db, s.workspaceId, s.productId, input);
    expect(flowBlocker((await getFlow(db, s.workspaceId, id))!, ORIGIN)?.code).toBe("needs_confirm");
    expect(await confirmFlow(db, sessionFor(s), id)).toBe(true);
    expect(flowBlocker((await getFlow(db, s.workspaceId, id))!, ORIGIN)).toBeNull();
    await updateFlow(db, s.workspaceId, id, { ...input, name: "Add a class" });
    expect(flowBlocker((await getFlow(db, s.workspaceId, id))!, ORIGIN)?.code).toBe("needs_confirm");
    // Another workspace can't confirm it.
    const other = await seedWorkspace(db);
    expect(await confirmFlow(db, sessionFor(other, "user-2"), id)).toBe(false);
  });

  it("only a UiSession can confirm a flow or set the trusted origin (type level)", () => {
    // Never called: these lines exist so tsc fails if a worker or agent could pass plain ids.
    const forged = () => {
      // @ts-expect-error a PAT/MCP handler or the worker has only ids, not a UiSession
      void confirmFlow(db, { userId: "agent", workspaceId: "ws" }, "flow");
      // @ts-expect-error the trusted origin is UI-only too (D26)
      void setTrustedOrigin(db, { userId: "agent", workspaceId: "ws" }, "product", "http://demo:3000", []);
    };
    expect(typeof forged).toBe("function");
  });

  it("a confirm records the session's user", async () => {
    const s = await seedWorkspace(db);
    const id = await createFlow(db, s.workspaceId, s.productId, { name: "Log in", needsLogin: true, steps: [{ kind: "goto", path: "/" }] });
    expect(await confirmFlow(db, sessionFor(s, "user-7"), id)).toBe(true);
    expect((await getFlow(db, s.workspaceId, id))!.confirmedBy).toBe("user-7");
  });
  it.todo("the recorder aborts requests and refuses clicks on the live page — apps/worker/src/capture/demo/recorder.ts:198/:297 (needs Chromium; server check)");
});
