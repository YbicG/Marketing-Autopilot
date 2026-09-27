import { describe, expect, it } from "vitest";
import {
  analyzeLanding,
  checkAnalytics,
  checkLoadTime,
  checkNoSignupWall,
  checkPricingVisible,
  checkSharePreview,
  checkSignupButton,
  checkTrackingSurvives,
  htmlToText,
  isLoginUrl,
  landingAuditPassed,
  needsSignupJudge,
} from "./audit.ts";
import { probeTracking } from "./audit-io.ts";
import { BlockedUrl } from "../../security/ssrf.ts";
import { goodSnapshot, noOgImageSnapshot, pricingOneClickSnapshot, signupWallSnapshot, utmStrippingSnapshot } from "./test-fixtures.ts";

const byId = (s: ReturnType<typeof goodSnapshot>) => Object.fromEntries(analyzeLanding(s).map((c) => [c.id, c]));

describe("landing audit analyzers", () => {
  it("passes a good landing page on every check", () => {
    const checks = analyzeLanding(goodSnapshot());
    expect(checks.map((c) => c.id)).toEqual(["load_time", "signup_button", "pricing_visible", "no_signup_wall", "share_preview", "analytics", "tracking_survives"]);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
    expect(landingAuditPassed(checks)).toBe(true);
  });

  it("load time: warns over 3 s, fails the gate over 8 s", () => {
    expect(checkLoadTime(goodSnapshot({ loadMs: 2_900 })).passed).toBe(true);
    const slow = checkLoadTime(goodSnapshot({ loadMs: 4_200 }));
    expect(slow).toMatchObject({ passed: false, severity: "warn" });
    expect(slow.detail).toContain("4.2 s");
    expect(checkLoadTime(goodSnapshot({ loadMs: 9_000 }))).toMatchObject({ passed: false, severity: "gate" });
    expect(landingAuditPassed(analyzeLanding(goodSnapshot({ loadMs: 4_200 })))).toBe(true);
    expect(landingAuditPassed(analyzeLanding(goodSnapshot({ loadMs: 9_000 })))).toBe(false);
  });

  it("sign-in wall: a redirect to /login fails no_signup_wall and the audit", () => {
    const c = byId(signupWallSnapshot());
    expect(c.no_signup_wall).toMatchObject({ passed: false, severity: "gate" });
    expect(c.no_signup_wall!.detail).toContain("/login");
    expect(c.signup_button!.passed).toBe(false);
    expect(landingAuditPassed(analyzeLanding(signupWallSnapshot()))).toBe(false);
  });

  it("sign-in wall: auth hosts, 401s and bare login forms", () => {
    expect(isLoginUrl("https://accounts.google.com/o/oauth2")).toBe(true);
    expect(isLoginUrl("https://myapp.clerk.accounts.dev/sign-in")).toBe(true);
    expect(isLoginUrl("https://syllacal.com/auth/callback")).toBe(true);
    expect(isLoginUrl("https://syllacal.com/authors")).toBe(false);
    expect(isLoginUrl("https://syllacal.com/")).toBe(false);
    expect(checkNoSignupWall(goodSnapshot({ status: 401 })).passed).toBe(false);
    expect(checkNoSignupWall(goodSnapshot({ status: 500 })).passed).toBe(false);
    expect(checkNoSignupWall(goodSnapshot({ html: `<form><input type="password"></form>` })).passed).toBe(false);
  });

  it("tracking: a redirect that strips the query fails and says where", () => {
    const c = checkTrackingSurvives(utmStrippingSnapshot());
    expect(c).toMatchObject({ passed: false, severity: "gate" });
    expect(c.detail).toContain("utm_source");
    expect(c.detail).toContain("redirect");
    expect(landingAuditPassed(analyzeLanding(utmStrippingSnapshot()))).toBe(false);
  });

  it("tracking: a missing or failed probe fails the check", () => {
    expect(checkTrackingSurvives(goodSnapshot({ trackingProbe: null })).passed).toBe(false);
    const err = checkTrackingSurvives(goodSnapshot({ trackingProbe: { sentParams: { utm_source: "test" }, finalUrl: "", error: "the page didn't answer" } }));
    expect(err.detail).toContain("didn't answer");
  });

  it("tracking: a changed value counts as lost", () => {
    const s = goodSnapshot();
    const probe = { ...s.trackingProbe!, finalUrl: s.trackingProbe!.finalUrl.replace("utm_source=test", "utm_source=other") };
    expect(checkTrackingSurvives({ ...s, trackingProbe: probe }).passed).toBe(false);
  });

  it("pricing: shown on the page, one click away, or missing", () => {
    expect(checkPricingVisible(goodSnapshot()).detail).toContain("$9.99");
    const oneClick = checkPricingVisible(pricingOneClickSnapshot());
    expect(oneClick.passed).toBe(true);
    expect(oneClick.detail).toContain("one click away");
    const none = checkPricingVisible(goodSnapshot({ html: "<h1>Hello</h1>", links: [{ href: "https://other.com/pricing", text: "Pricing" }] }));
    expect(none.passed).toBe(false);
    expect(checkPricingVisible(goodSnapshot({ html: "<p>Only &euro;5 once</p>", links: [] })).passed).toBe(true);
  });

  it("share preview: no og:image is a warning only", () => {
    const c = checkSharePreview(noOgImageSnapshot());
    expect(c).toMatchObject({ passed: false, severity: "warn" });
    expect(c.detail).toContain("share picture");
    expect(landingAuditPassed(analyzeLanding(noOgImageSnapshot()))).toBe(true);
    expect(checkSharePreview(goodSnapshot({ meta: {} })).detail).toContain("description");
  });

  it("analytics: known hosts or the product's own beacon; warn only", () => {
    expect(checkAnalytics(goodSnapshot()).passed).toBe(true);
    expect(checkAnalytics(goodSnapshot({ html: "<p>x</p>", scripts: ["www.googletagmanager.com"] })).passed).toBe(true);
    expect(checkAnalytics(goodSnapshot({ html: "<p>x</p>", scripts: ["plausible.io"] })).passed).toBe(true);
    const none = checkAnalytics(goodSnapshot({ html: "<p>x</p>", scripts: ["cdn.example.com"] }));
    expect(none).toMatchObject({ passed: false, severity: "warn" });
  });

  it("sign-up button: needs phones and computers; the judge can confirm the phone view", () => {
    const noMobile = goodSnapshot({ mobile: { text: "Your syllabus", buttons: [{ text: "Menu" }], screenshotAssetId: "shot-m" } });
    expect(checkSignupButton(noMobile)).toMatchObject({ passed: false, severity: "gate" });
    expect(checkSignupButton(noMobile).detail).toContain("phones");
    expect(needsSignupJudge(noMobile)).toBe(true);
    expect(needsSignupJudge(goodSnapshot())).toBe(false);
    const judged = checkSignupButton(noMobile, { signupButtonVisible: true, buttonText: "Upload syllabus", reason: "big button" });
    expect(judged.passed).toBe(true);
    expect(judged.detail).toContain("phone screenshot");
    expect(checkSignupButton(noMobile, { signupButtonVisible: false, buttonText: null, reason: "none" }).passed).toBe(false);
    const noDesktop = goodSnapshot({ desktop: { text: "", buttons: [{ text: "About" }], screenshotAssetId: null } });
    expect(checkSignupButton(noDesktop).detail).toContain("computers");
  });

  it("htmlToText drops scripts and decodes entities", () => {
    expect(htmlToText("<p>A&nbsp;&amp;&nbsp;B</p><script>var x = '$5'</script>")).toBe("A & B");
  });
});

describe("probeTracking", () => {
  it("reports the final URL and redirect chain", async () => {
    const probe = await probeTracking(
      "https://syllacal.com/",
      async (url) => ({ url: url.replace("https://syllacal.com/", "https://www.syllacal.com/"), redirects: ["https://www.syllacal.com/?x"], status: 200 }),
      "n1",
    );
    expect(probe.sentParams.utm_content).toBe("mkt-audit-n1");
    expect(probe.finalUrl).toContain("utm_content=mkt-audit-n1");
    expect(probe.redirectChain).toHaveLength(1);
  });

  it("turns fetch failures into a plain error", async () => {
    const blocked = await probeTracking("https://syllacal.com/", async () => {
      throw new BlockedUrl("That website sent us somewhere we're not allowed to go.", "blocked_redirect");
    });
    expect(blocked.error).toContain("not allowed");
    const down = await probeTracking("https://syllacal.com/", async () => {
      throw new Error("ECONNRESET");
    });
    expect(down.error).toBe("the page didn't answer");
  });
});
