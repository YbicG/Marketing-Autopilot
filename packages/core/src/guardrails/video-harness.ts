// Test-only: the core video pipeline (script → spec → finalize → render) on fakes, as in
// video/video.test.ts, with a renderer that logs the order of file edits.
import type { VideoSpec } from "@mkt/contracts";
import type { Db } from "@mkt/db";
import { fakeClient, jsonReply, type FakeReply } from "../ai/testing.ts";
import type { RateLookup } from "../ai/usage.ts";
import type { VideoDeps } from "../video/deps.ts";
import { confirmFinalize, executeFinalize, executeRenderVideo, finalizeHash } from "../video/finalize.ts";
import { latestSpec } from "../video/spec.ts";
import { fakeAudio, fakeRenderer, fakeTools, memoryStorage, scriptReply, specReply, type VideoWorld } from "../video/testing.ts";
import { runVideoItem } from "../video/video-item.ts";

function claude(w: VideoWorld) {
  const route: FakeReply = (p) => {
    const s = String(p.system);
    if (s.startsWith("You write short vertical videos")) return jsonReply(scriptReply(w.shotId));
    if (s.startsWith("You turn a short video script")) return jsonReply(specReply(w.shotId, scriptReply(w.shotId)));
    if (s.startsWith("You check a finished")) return jsonReply({ issues: [], personalData: [] });
    if (s.startsWith("You review a short product video")) {
      return jsonReply({
        hooks: [0, 1, 2].map((hookIdx) => ({ hookIdx, propositionBy3s: true, openingBy6s: true, brandEarly: true, lastLineSpoken: true, lastLineOnScreen: true, honest: true, note: "" })),
        pairwise: [{ a: 0, b: 1, better: 1 }, { a: 0, b: 2, better: 2 }, { a: 1, b: 2, better: 1 }],
      });
    }
    throw new Error(`unexpected call: ${s.slice(0, 60)}`);
  };
  return fakeClient(Array.from({ length: 60 }, () => route));
}

/** The core video deps with a fake renderer that logs the order of file edits. */
export function videoHarness(db: Db, rates: RateLookup, w: VideoWorld) {
  const renderer = fakeRenderer();
  const log: string[] = [];
  const xmp: { path: string; dst: string }[] = [];
  const transcode = renderer.transcodeVariants.bind(renderer);
  renderer.transcodeVariants = async (...a) => {
    log.push("transcode");
    return transcode(...a);
  };
  const still = renderer.renderStillImage.bind(renderer);
  renderer.renderStillImage = async (...a) => {
    log.push("still");
    return still(...a);
  };
  const write = renderer.writeXmp.bind(renderer);
  renderer.writeXmp = async (path, dst) => {
    log.push("xmp");
    xmp.push({ path, dst });
    return write(path, dst);
  };
  const queued: string[] = [];
  const { client } = claude(w);
  const deps: VideoDeps = {
    db,
    rates,
    storage: memoryStorage({ [w.shotKey]: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
    client,
    audio: fakeAudio(),
    providerCtx: { secret: async () => "k" },
    renderer,
    tools: fakeTools(),
    voidApprovalsFor: async () => {},
    enqueueRender: async (id) => {
      queued.push(id);
    },
    defaultVoiceId: "v1",
  };
  return { deps, renderer, log, xmp, queued };
}

export type VideoHarness = ReturnType<typeof videoHarness>;

/** Draft → confirm → finalize → render every queued opening line. Returns how many renders ran. */
export async function finalizeAndRender(db: Db, h: VideoHarness, w: VideoWorld): Promise<number> {
  await runVideoItem(h.deps, w.runId, w.ws, w.itemId);
  const spec = (await latestSpec(db, w.ws, w.itemId))!.spec as unknown as VideoSpec;
  await confirmFinalize(db, { workspaceId: w.ws, contentItemId: w.itemId, userId: w.userId, shownHash: finalizeHash(spec) });
  await executeFinalize(h.deps, { runId: w.runId, contentItemId: w.itemId, workspaceId: w.ws });
  const n = h.queued.length;
  while (h.queued.length) await executeRenderVideo(h.deps, h.queued.shift()!);
  return n;
}
