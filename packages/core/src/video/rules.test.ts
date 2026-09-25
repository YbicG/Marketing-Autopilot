import { describe, expect, it } from "vitest";
import type { VideoSpec } from "@mkt/contracts";
import type { ClaimRow } from "./context.ts";
import { applyOverride, assertPublishableTier, computeTier, digitalSourceType } from "./provenance.ts";
import { rankFromPairwise, stage0, type Stage0Input } from "./qa.ts";
import { dHash, hamming, sceneOverlap, werBp } from "./qa-rules.ts";
import { memorySemaphoreRedis, RedisSemaphore, SemaphoreBusy } from "./semaphore.ts";
import { fakeRenderer, fakeTools, goodProbe } from "./testing.ts";
import { checkUpload, sniffMedia, UPLOAD_CAPS, UploadRejected } from "./uploads.ts";

const SHOT = "shot1";
const spec: VideoSpec = {
  schemaVersion: 1,
  format: "9x16",
  fps: 30,
  targetSeconds: 30,
  brand: { colors: ["#111827"], font: "Inter", logoAssetId: null },
  voice: { voiceId: "v1", model: "final" },
  music: { mood: "calm", duckDb: -12, trackAssetId: null },
  captions: { enabled: true, style: "tiktok" },
  hookVariants: [
    { style: "pov", onScreen: "POV: 5 syllabi", vo: "POV: five syllabi." },
    { style: "question", onScreen: "Still typing?", vo: "Still typing deadlines?" },
    { style: "speed_demo", onScreen: "15 seconds", vo: "Fifteen seconds, whole term." },
  ],
  scenes: [
    { id: "s1", type: "ScreenshotKenBurns", vo: "Drop the PDF in.", minMs: 2000, visual: { kind: "screenshot", assetId: SHOT }, claimRefs: ["C1"] },
    { id: "s2", type: "KineticText", vo: "Done.", minMs: 2000, visual: { kind: "kineticText" }, overlay: { text: "Done", position: "center" } },
  ],
  transitions: [],
  sfx: [],
  cta: { onScreen: "Link in bio", vo: "Link in bio." },
  disclosures: [],
};

const claim = (over: Partial<ClaimRow>): ClaimRow => ({ ref: "C1", text: "Syllabus to calendar in 15 s", publicOk: true, status: "unverified", expiresAt: null, ...over }) as ClaimRow;
const now = new Date("2026-09-25T12:00:00Z");

function input(over: Partial<Stage0Input> = {}): Stage0Input {
  const tools = fakeTools();
  return {
    spec,
    script: { claimRefs: ["C1"] },
    claims: [claim({})],
    timeline: tools.resolveTimeline(spec, { "hook:0": 1000, s1: 1500, s2: 500, cta: 800 }, 0),
    lintCtx: { assets: {}, publicClaimRefs: new Set(["C1"]), verifiedClaimRefs: new Set() },
    probes: [{ platform: "tiktok", probe: goodProbe() }],
    loudness: { lufs: -14.2, truePeak: -1.6 },
    sheetHashes: [],
    recent: [],
    now,
    ...over,
  };
}

const deps = (over: Partial<ReturnType<typeof fakeTools>> = {}, renderer = fakeRenderer()) => ({ tools: { ...fakeTools(), ...over }, renderer });
const codes = (issues: { code: string; severity: string }[]) => issues.map((i) => `${i.severity}:${i.code}`);

describe("QA stage 0", () => {
  it("passes a clean video", () => {
    expect(codes(stage0(deps(), input())).filter((c) => c.startsWith("block"))).toEqual([]);
  });

  it("blocks loudness outside −14 ±1 LUFS and warns on hot peaks", () => {
    const out = codes(stage0(deps(), input({ loudness: { lufs: -17, truePeak: -0.5 } })));
    expect(out).toContain("block:loudness");
    expect(out).toContain("warn:true_peak");
  });

  it("blocks text under the platform buttons", () => {
    const out = stage0(deps({ inSafeZone: (_b, p) => p !== "tiktok" }), input());
    const safe = out.filter((i) => i.code === "safe_zone");
    expect(safe.length).toBeGreaterThan(0);
    expect(safe[0]!.message).toContain("TikTok");
  });

  it("blocks a claim that went private, was rejected or expired", () => {
    for (const c of [claim({ publicOk: false }), claim({ status: "rejected" }), claim({ expiresAt: new Date("2026-09-01") })]) {
      expect(codes(stage0(deps(), input({ claims: [c] })))).toContain("block:claim_invalid");
    }
    expect(codes(stage0(deps(), input({ claims: [] })))).toContain("block:claim_missing");
  });

  it("warns on a spoken web address", () => {
    const s = { ...spec, cta: { onScreen: "syllacal.app", vo: "Go to syllacal dot app" } };
    expect(codes(stage0(deps(), input({ spec: s })))).toContain("warn:link_text");
  });

  it("passes platform probe failures and lint issues through", () => {
    const renderer = fakeRenderer();
    renderer.checkAgainstPlatform = () => [{ code: "faststart", message: "moov atom at the end", severity: "block" }];
    const out = stage0(deps({ lintSpec: () => [{ code: "wps", message: "too fast", severity: "block", sceneId: "s1" }] }, renderer), input());
    expect(codes(out)).toEqual(expect.arrayContaining(["block:probe_tiktok:faststart", "block:wps"]));
  });

  it("warns when most of the runtime is plain text", () => {
    const allText = { ...spec, scenes: spec.scenes.map((s) => ({ ...s, type: "KineticText" as const, visual: { kind: "kineticText" as const } })) };
    const t = fakeTools().resolveTimeline(allText, {}, 0);
    expect(codes(stage0(deps(), input({ spec: allText, timeline: t })))).toContain("warn:text_coverage");
  });

  it("warns when scenes repeat a video from the last 7 days", () => {
    const h = ["00ff00ff00ff00ff", "0f0f0f0f0f0f0f0f", "ffff0000ffff0000"];
    expect(codes(stage0(deps(), input({ sheetHashes: h, recent: [{ label: "another video", hashes: h }] })))).toContain("warn:scene_overlap");
    expect(sceneOverlap(h, ["1234567890abcdef"])).toBe(0);
  });
});

describe("QA helpers", () => {
  it("word error rate in basis points", () => {
    expect(werBp("Drop your syllabus in.", "drop your syllabus in")).toBe(0);
    expect(werBp("drop your syllabus in", "stop your silly bus in")).toBeGreaterThan(500);
  });

  it("dHash distance", () => {
    const g = new Uint8Array(72).map((_, i) => (i * 37) % 256);
    expect(hamming(dHash(g), dHash(g))).toBe(0);
    expect(hamming(dHash(g), dHash(g.map((x) => 255 - x)))).toBeGreaterThan(30);
  });

  it("ranks opening lines by pairwise wins", () => {
    expect(rankFromPairwise(3, [{ a: 0, b: 1, better: 1 }, { a: 0, b: 2, better: 2 }, { a: 1, b: 2, better: 1 }])).toEqual([1, 2, 0]);
    expect(rankFromPairwise(3, [])).toEqual([0, 1, 2]);
  });
});

describe("computeTier (D18)", () => {
  it("real footage is A, a synthetic voice or music makes it B, generative visuals C", () => {
    expect(computeTier([{ kind: "asset", origin: "captured" }, { kind: "asset", origin: "uploaded" }])).toBe("A");
    expect(computeTier([{ kind: "asset", origin: "captured" }, { kind: "tts" }])).toBe("B");
    expect(computeTier([{ kind: "music" }])).toBe("B");
    expect(computeTier([{ kind: "generative_image", nonPhotorealChecked: true }])).toBe("B");
    expect(computeTier([{ kind: "generative_image" }])).toBe("C");
    expect(computeTier([{ kind: "generative_video" }, { kind: "tts" }])).toBe("C");
    expect(computeTier([{ kind: "asset", origin: "generated" }])).toBe("C");
    expect(computeTier([{ kind: "asset", origin: "template", provenanceTier: "B" }])).toBe("B");
    expect(computeTier([])).toBe("A");
  });

  it("an override can only raise the tier; C never publishes", () => {
    expect(applyOverride("B", "A")).toBe("B");
    expect(applyOverride("A", "C")).toBe("C");
    expect(() => assertPublishableTier("C")).toThrow();
    expect(digitalSourceType("A")).toContain("composite");
    expect(digitalSourceType("B")).toContain("compositeWithTrainedAlgorithmicMedia");
    expect(digitalSourceType("C")).toContain("trainedAlgorithmicMedia");
  });
});

describe("upload sniffing", () => {
  const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49]);

  it("trusts the bytes, not the name", () => {
    expect(sniffMedia(png)).toEqual({ kind: "image", mime: "image/png", ext: "png" });
    expect(sniffMedia(ftyp("isom"))).toEqual({ kind: "recording", mime: "video/mp4", ext: "mp4" });
    expect(sniffMedia(ftyp("qt  "))).toEqual({ kind: "recording", mime: "video/quicktime", ext: "mov" });
    expect(sniffMedia(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime).toBe("video/webm");
    expect(sniffMedia(ftyp("heic"))).toBeNull();
    expect(sniffMedia(new TextEncoder().encode("<svg onload=alert(1)></svg>"))).toBeNull();
    expect(() => checkUpload(new TextEncoder().encode("#!/bin/sh\nrm -rf /\n"))).toThrow(UploadRejected);
  });

  it("caps images at 20 MB and recordings at 300 MB", () => {
    const big = (head: Uint8Array, size: number) => {
      const b = new Uint8Array(size);
      b.set(head);
      return b;
    };
    expect(() => checkUpload(big(png, UPLOAD_CAPS.image + 1))).toThrow(/limit is 20 MB/);
    expect(checkUpload(big(png, UPLOAD_CAPS.image)).kind).toBe("image");
    expect(() => checkUpload(big(ftyp("mp42"), UPLOAD_CAPS.recording + 1))).toThrow(/limit is 300 MB/);
  });
});

describe("sem:heavy", () => {
  it("lets one heavy job run at a time", async () => {
    let t = 0;
    const redis = memorySemaphoreRedis(() => t);
    const sleep = async (ms: number) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    };
    const sem = (name?: string) => new RedisSemaphore(redis, { ...(name ? { name } : {}), pollMs: 100, waitMs: 60_000, sleep, now: () => t });
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    const job = (id: string) =>
      sem().run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        order.push(`start ${id}`);
        await sleep(500);
        order.push(`end ${id}`);
        running--;
      });
    await Promise.all([job("a"), job("b"), job("c")]);
    expect(maxRunning).toBe(1);
    expect(order).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) expect(order[i + 1]!.slice(4)).toBe(order[i]!.slice(6));
  });

  it("gives up after waitMs and releases on error", async () => {
    let t = 0;
    const redis = memorySemaphoreRedis(() => t);
    const opts = { pollMs: 100, waitMs: 300, sleep: async (ms: number) => void (t += ms), now: () => t };
    const holder = await new RedisSemaphore(redis, opts).acquire();
    await expect(new RedisSemaphore(redis, opts).acquire()).rejects.toBeInstanceOf(SemaphoreBusy);
    await holder.release();
    await expect(new RedisSemaphore(redis, opts).run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await new RedisSemaphore(redis, opts).tryAcquire()).not.toBeNull();
  });

  it("an expired lease frees the slot (a crashed worker doesn't block forever)", async () => {
    let t = 0;
    const redis = memorySemaphoreRedis(() => t);
    const a = new RedisSemaphore(redis, { ttlMs: 1_000, now: () => t });
    expect(await a.tryAcquire()).not.toBeNull();
    expect(await a.tryAcquire()).toBeNull();
    t += 1_001;
    expect(await a.tryAcquire()).not.toBeNull();
  });
});
