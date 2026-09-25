// M0 server check, run inside the worker container (Dokploy terminal):
//   pnpm --filter @mkt/worker smoke
// 1. vCPU/RAM, 2. a Playwright screenshot of an inline page, 3. a 3 s Remotion render checked with ffprobe.
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { SMOKE_COMPOSITION } from "@mkt/video";
import { renderVideo } from "@mkt/video/render";
import { serverInfo } from "../boot/server-info.ts";

const run = promisify(execFile);
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`[smoke] ${ok ? "PASS" : "FAIL"} ${check}: ${detail}`);
};

const dir = await mkdtemp(join(tmpdir(), "mkt-smoke-"));
try {
  const info = serverInfo();
  record("server", info.cpus >= 4 && info.totalMemGb >= 8, `${info.cpus} vCPU, ${info.totalMemGb} GB total`);

  try {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent("<main style='font:48px sans-serif;padding:40px'>Playwright OK</main>");
    const png = join(dir, "shot.png");
    await page.screenshot({ path: png, fullPage: true });
    await browser.close();
    const { size } = await stat(png);
    record("playwright", size > 1_000, `${size} byte screenshot`);
  } catch (err) {
    record("playwright", false, err instanceof Error ? err.message : String(err));
  }

  try {
    const out = join(dir, "smoke.mp4");
    const started = performance.now();
    await renderVideo({
      compositionId: SMOKE_COMPOSITION,
      inputProps: { label: "Render OK" },
      outputLocation: out,
      concurrency: Number(process.env.REMOTION_CONCURRENCY ?? 2),
    });
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", out]);
    const probe = JSON.parse(stdout) as {
      streams: { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string }[];
      format: { duration: string };
    };
    const v = probe.streams.find((s) => s.codec_type === "video");
    const duration = Number(probe.format.duration);
    const ok = v?.codec_name === "h264" && v.width === 1080 && v.height === 1920 && v.pix_fmt === "yuv420p" && Math.abs(duration - 3) < 0.2;
    record("remotion", ok, `${v?.codec_name} ${v?.width}x${v?.height} ${v?.pix_fmt} ${duration.toFixed(2)}s, rendered in ${secs}s`);
  } catch (err) {
    record("remotion", false, err instanceof Error ? err.message : String(err));
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `[smoke] ${failed.length} check(s) failed` : "[smoke] all checks passed");
process.exit(failed.length ? 1 : 0);
