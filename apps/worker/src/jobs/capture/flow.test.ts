// capture.flow with the recorder faked (no browser, no ffmpeg): blockers, storage, PII flagging.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmFlow, createFlow, getFlow, setTrustedOrigin, SYLLACAL_ROUTE_DENYLIST_SUGGESTION } from "@mkt/core/capture";
import { loadRateCards, rateLookup, seedPricingRates } from "@mkt/core/cost";
import { fsStorage, type Storage } from "@mkt/core/media";
import { schema, uuidv7, type Db } from "@mkt/db";
import { createTestDb } from "@mkt/db/testing";
import { CaptureBlocked, type RecordFlowOptions, type RecordFlowResult } from "../../capture/demo/recorder.ts";
import { captureFlow, loginPurpose, type CaptureFlowDeps } from "./flow.ts";

let db: Db;
let close: () => Promise<void>;
let dir: string;
let store: Storage;
let ws: string;
let productId: string;
let deps: CaptureFlowDeps;
const recorded: RecordFlowOptions[] = [];
let screenTexts: string[] = ["Calendar"];
let heavyCalls = 0;
const secrets: { ws: string; purpose: string }[] = [];

const fakeRecord = async (opts: RecordFlowOptions): Promise<RecordFlowResult> => {
  recorded.push(opts);
  if (opts.flow.name === "Explodes") throw new CaptureBlocked('Stopped before clicking "Delete".');
  const mp4Path = join(opts.workDir, "recording.mp4");
  await writeFile(mp4Path, new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, recorded.length]));
  const frame = join(opts.workDir, "f0.jpg");
  await writeFile(frame, new Uint8Array([0xff, 0xd8, 0xff]));
  return {
    mp4Path,
    durationMs: 3_033,
    width: 1440,
    height: 900,
    clickLog: [{ tMs: 500, x: 0.4, y: 0.6, type: "click" }],
    screenTexts,
    frames: [{ tMs: 0, path: frame }],
    blocked: [{ reason: "off_origin", detail: "font fonts.gstatic.com" }],
  };
};

// The worker has no drizzle-orm dependency of its own; the table is small.
const assetById = async (id: string) => (await db.select().from(schema.assets)).find((a) => a.id === id);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedPricingRates(db);
  dir = await mkdtemp(join(tmpdir(), "mkt-capture-job-"));
  store = fsStorage(join(dir, "store"));
  ws = uuidv7();
  productId = uuidv7();
  await db.insert(schema.workspaces).values({ id: ws, name: "t" });
  await db.insert(schema.products).values({ id: productId, workspaceId: ws, slug: "syllacal", name: "SyllaCal" });
  deps = {
    db,
    rates: rateLookup(await loadRateCards(db)),
    storage: store,
    withHeavy: async (fn) => {
      heavyCalls++;
      return fn();
    },
    framesToCfr: async () => undefined,
    resolveSecret: async (w, purpose) => {
      secrets.push({ ws: w, purpose });
      return { username: "demo", password: "not-logged" };
    },
    proxyUrl: "http://smokescreen:4750",
    piiVision: false,
    record: fakeRecord,
    tmpRoot: dir,
  };
}, 60_000);
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

describe("capture.flow job", () => {
  it("won't record before the trusted origin is set", async () => {
    const flowId = await createFlow(db, ws, productId, { name: "Week view", needsLogin: false, steps: [{ kind: "goto", path: "/calendar" }] });
    await captureFlow(deps, { flowId });
    expect(recorded).toHaveLength(0);
    expect((await getFlow(db, ws, flowId))!.lastError).toMatch(/internal address/);
  });

  it("records, stores the asset + click log and points the flow at it", async () => {
    await setTrustedOrigin(db, ws, productId, "http://syllacal-demo:3000", [...SYLLACAL_ROUTE_DENYLIST_SUGGESTION]);
    const flowId = await createFlow(db, ws, productId, { name: "Month view", needsLogin: false, steps: [{ kind: "goto", path: "/calendar" }] });
    await captureFlow(deps, { flowId });
    expect(heavyCalls).toBe(1);
    const opts = recorded.at(-1)!;
    expect(opts.origin).toBe("http://syllacal-demo:3000");
    expect(opts.routeDenylist).toContain("/api/checkout");
    expect(opts.login).toBeNull();
    const flow = (await getFlow(db, ws, flowId))!;
    expect(flow.lastError).toBeNull();
    const asset = await assetById(flow.lastRecordingAssetId!);
    expect(asset).toMatchObject({ kind: "recording", durationMs: 3_033, piiHits: false, width: 1440 });
    expect(asset!.clickLogKey).toMatch(/-clicks\.json$/);
    expect(asset!.origination).toMatchObject({ blockedRequests: { off_origin: 1 } });
  });

  it("needs the confirm click for login flows, then logs in through the secret resolver", async () => {
    const flowId = await createFlow(db, ws, productId, { name: "My courses", needsLogin: true, steps: [{ kind: "goto", path: "/courses" }] });
    const before = recorded.length;
    await captureFlow(deps, { flowId });
    expect(recorded).toHaveLength(before);
    expect((await getFlow(db, ws, flowId))!.lastError).toMatch(/confirm/);

    await confirmFlow(db, ws, "user-1", flowId);
    await captureFlow(deps, { flowId });
    expect(secrets.at(-1)).toEqual({ ws, purpose: loginPurpose(productId) });
    expect(recorded.at(-1)!.login).toEqual({ username: "demo", password: "not-logged" });
    const flow = (await getFlow(db, ws, flowId))!;
    expect(JSON.stringify(flow)).not.toContain("not-logged");
  });

  it("flags personal data as Needs you", async () => {
    screenTexts = ["Jamie Rivera jamie.rivera@acme-mail.com"];
    const flowId = await createFlow(db, ws, productId, { name: "Classmates", needsLogin: false, steps: [{ kind: "goto", path: "/people" }] });
    await captureFlow(deps, { flowId });
    const flow = (await getFlow(db, ws, flowId))!;
    expect(flow.lastError).toMatch(/^Needs you: personal info/);
    const asset = await assetById(flow.lastRecordingAssetId!);
    expect(asset!.piiHits).toBe(true);
    screenTexts = ["Calendar"];
  });

  it("a click-time block ends the job without a retry", async () => {
    const flowId = await createFlow(db, ws, productId, { name: "Explodes", needsLogin: false, steps: [{ kind: "goto", path: "/x" }] });
    await expect(captureFlow(deps, { flowId })).resolves.toBeUndefined();
    const flow = (await getFlow(db, ws, flowId))!;
    expect(flow.lastError).toMatch(/Stopped before clicking/);
    expect(flow.lastRecordingAssetId).toBeNull();
  });
});
