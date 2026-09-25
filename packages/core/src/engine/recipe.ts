import {
  M2_GENERATORS,
  type Audience,
  type GeneratorId,
  type PackageRecipe,
  type PackageTier,
  type ProductKind,
  type RecipeLine,
  type RecipeTarget,
  type SocialPlatform,
} from "@mkt/contracts";

// §2.5 / §5.3 (D12): counts are cadence × platforms × 30 days. Only deliverables whose generator is
// enabled are generated; the rest still get calendar slots, shown as Open.

interface Cadence {
  audience: Audience;
  platforms: SocialPlatform[];
  masters: number;
  hooksPerMaster: number;
  videoTargets: RecipeTarget[];
  swipes: number;
  swipeTargets: RecipeTarget[];
  textPosts: RecipeTarget[];
  threads: RecipeTarget[];
}

const t = (platform: SocialPlatform, format: RecipeTarget["format"], count: number): RecipeTarget => ({ platform, format, count });

/**
 * Standard 30-day cadences. B2C web (SyllaCal): TikTok 14 (6 videos + 8 photo posts), IG 6 Reels +
 * 8 swipe posts, Shorts 6, Threads 20, X 20 + 2 threads. Dev tool: 4 masters × 2 lines, X 30 + 4
 * threads, Bluesky 20, LinkedIn (§5.3; the assisted HN/Reddit kit is M7).
 */
function standardCadence(kind: ProductKind): Cadence {
  if (kind === "web_b2b") {
    return {
      audience: "b2b",
      platforms: ["linkedin", "x", "youtube", "threads"],
      masters: 6,
      hooksPerMaster: 3,
      videoTargets: [t("youtube", "video", 6), t("linkedin", "video", 6)],
      swipes: 8,
      swipeTargets: [t("linkedin", "document", 8)],
      textPosts: [t("linkedin", "text", 12), t("x", "text", 20), t("threads", "text", 20)],
      threads: [t("x", "thread", 2)],
    };
  }
  if (kind === "devtool") {
    return {
      audience: "developers",
      platforms: ["x", "bluesky", "linkedin"],
      masters: 4,
      hooksPerMaster: 2,
      videoTargets: [t("x", "video", 4), t("linkedin", "video", 4)],
      swipes: 4,
      swipeTargets: [t("linkedin", "document", 4)],
      textPosts: [t("x", "text", 30), t("bluesky", "text", 20), t("linkedin", "text", 8)],
      threads: [t("x", "thread", 4)],
    };
  }
  // web_b2c, and mobile/unknown until M7 adds their own recipes.
  return {
    audience: "students",
    platforms: ["tiktok", "instagram", "youtube", "threads", "x"],
    masters: 6,
    hooksPerMaster: 3,
    videoTargets: [t("tiktok", "video", 6), t("instagram", "video", 6), t("youtube", "video", 6)],
    swipes: 8,
    swipeTargets: [t("instagram", "carousel", 8), t("tiktok", "photo", 8)],
    textPosts: [t("threads", "text", 20), t("x", "text", 20)],
    threads: [t("x", "thread", 2)],
  };
}

/** Quick ≈ a third of Standard, Premium ≈ 2× on volume (§2.5 package prices). */
const TIER_SCALE: Record<PackageTier, { video: number; swipe: number; text: number; thread: number }> = {
  quick: { video: 1 / 3, swipe: 3 / 8, text: 0.3, thread: 0 },
  standard: { video: 1, swipe: 1, text: 1, thread: 1 },
  premium: { video: 2, swipe: 2, text: 1.5, thread: 2 },
};

const scale = (n: number, f: number) => (n === 0 ? 0 : Math.max(f > 0 ? 1 : 0, Math.round(n * f)));
const scaleTargets = (ts: RecipeTarget[], f: number) => ts.map((x) => ({ ...x, count: scale(x.count, f) })).filter((x) => x.count > 0);
const maxCount = (ts: RecipeTarget[]) => ts.reduce((m, x) => Math.max(m, x.count), 0);

export interface RecipeOptions {
  /** Generators switched on. Default: the M2 set (videos stay Open until M3a flips "video" on). */
  generators?: readonly GeneratorId[];
  /** Restrict to these platforms (e.g. the ones the user kept on the plan screen). */
  platforms?: readonly SocialPlatform[];
}

export function buildRecipe(kind: ProductKind, tier: PackageTier, opts: RecipeOptions = {}): PackageRecipe {
  const on = new Set(opts.generators ?? M2_GENERATORS);
  const c = standardCadence(kind);
  const s = TIER_SCALE[tier];
  const keep = (ts: RecipeTarget[]) => (opts.platforms ? ts.filter((x) => opts.platforms!.includes(x.platform)) : ts);
  const platforms = opts.platforms ? c.platforms.filter((p) => opts.platforms!.includes(p)) : c.platforms;

  const video = keep(scaleTargets(c.videoTargets, s.video));
  const swipe = keep(scaleTargets(c.swipeTargets, s.swipe));
  const text = keep(scaleTargets(c.textPosts, s.text));
  const threads = keep(scaleTargets(c.threads, s.thread));
  const pinnable = platforms.filter((p) => ["x", "threads", "bluesky"].includes(p));

  const line = (l: Omit<RecipeLine, "enabled">): RecipeLine => ({ ...l, enabled: on.has(l.generator) });
  const lines: RecipeLine[] = [
    line({ key: "master", kind: "video", generator: "video", count: maxCount(video), targets: video, hooksPerMaster: c.hooksPerMaster, scheduled: true, label: "Short videos" }),
    line({ key: "swipe", kind: "carousel", generator: "carousel", count: maxCount(swipe), targets: swipe, hooksPerMaster: null, scheduled: true, label: "Swipe posts" }),
    line({ key: "text", kind: "post", generator: "posts", count: maxCount(text), targets: text, hooksPerMaster: null, scheduled: true, label: "Posts" }),
    line({ key: "xthread", kind: "thread", generator: "threads", count: maxCount(threads), targets: threads, hooksPerMaster: null, scheduled: true, label: "Threads on X" }),
    line({
      key: "bio",
      kind: "bio",
      generator: "bio",
      count: platforms.length ? 1 : 0,
      targets: platforms.map((p) => t(p, "text", 1)),
      hooksPerMaster: null,
      scheduled: false,
      label: "Profile bios",
    }),
    line({
      key: "pinned",
      kind: "pinned",
      generator: "bio",
      count: pinnable.length ? 1 : 0,
      targets: pinnable.map((p) => t(p, "text", 1)),
      hooksPerMaster: null,
      scheduled: false,
      label: "Pinned posts",
    }),
  ].filter((l) => l.count > 0);

  return {
    schemaVersion: 1,
    tier,
    productKind: kind,
    audience: c.audience,
    days: 30,
    platforms,
    lines,
    brollPerMaster: tier === "premium",
  };
}

/** Scheduled posts per platform in a recipe (the D12 cadence), counting disabled lines too. */
export function slotsPerPlatform(recipe: PackageRecipe): Partial<Record<SocialPlatform, number>> {
  const out: Partial<Record<SocialPlatform, number>> = {};
  for (const l of recipe.lines) {
    if (!l.scheduled) continue;
    for (const x of l.targets) out[x.platform] = (out[x.platform] ?? 0) + x.count;
  }
  return out;
}
