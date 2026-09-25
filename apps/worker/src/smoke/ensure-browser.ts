// Image build step: download Remotion's Chrome Headless Shell into apps/worker/node_modules/.remotion,
// so renders never download anything at runtime. Run with cwd = apps/worker (pnpm --filter does this).
import { ensureBrowser } from "@mkt/video/render";

await ensureBrowser();
console.log("[ensure-browser] Remotion browser ready");
