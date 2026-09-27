import { REFERRAL_REF_RE, type KitDisclosure } from "@mkt/contracts";

// Referral links and the endorsement copy every ambassador / creator kit carries (§8, 16 CFR 255).

/**
 * `${site}/go/${ref}` plus tracking params. SyllaCal's /go/[ref] sets the referral cookie for any
 * ref matching REFERRAL_REF_RE, then redirects to "/".
 */
export function ambassadorLink(site: string, ref: string, opts: { campaign?: string } = {}): string {
  if (!REFERRAL_REF_RE.test(ref)) throw new Error(`"${ref}" can't be a referral code. Use letters, numbers, - or _ (up to 64).`);
  let base: URL;
  try {
    base = new URL(site);
  } catch {
    throw new Error("Your website address doesn't look right. Fix it on the product page.");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("Your website address must start with https://.");
  const url = new URL(`/go/${ref}`, base.origin);
  url.searchParams.set("utm_source", "ambassador");
  url.searchParams.set("utm_medium", "referral");
  url.searchParams.set("utm_campaign", opts.campaign ?? "launch");
  url.searchParams.set("utm_content", ref);
  return url.toString();
}

/** A referral code from a name ("Maya Chen" → "maya-chen"), unique within `taken` (which it updates). */
export function ambassadorRef(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "") || "ambassador";
  let ref = base;
  for (let i = 2; taken.has(ref); i++) ref = `${base}-${i}`;
  taken.add(ref);
  return ref;
}

/** The exact start of every ambassador caption. */
export const AMBASSADOR_CAPTION_PREFIX = "#ad I get a reward when you sign up with my link.";

export const AMBASSADOR_DISCLOSURE: KitDisclosure = {
  captionPrefix: AMBASSADOR_CAPTION_PREFIX,
  spokenLine: "Quick note: I get a reward if you sign up with my link.",
  rules: [
    `Start every caption with: ${AMBASSADOR_CAPTION_PREFIX}`,
    "In videos, say it out loud near the start too. A caption alone is easy to miss.",
    "Don't hide it in hashtags at the end or behind \"more\".",
    "On TikTok, also switch on the branded content setting (steps below).",
    "Only say things you believe about the app. Never post a review for something you haven't used.",
  ],
};

export function creatorDisclosure(productName: string): KitDisclosure {
  const captionPrefix = `#ad I'm partnering with ${productName}.`;
  return {
    captionPrefix,
    spokenLine: `Heads up: this is a paid partnership with ${productName}.`,
    rules: [
      `Start the caption with: ${captionPrefix}`,
      "Say it out loud in the first few seconds of the video.",
      "Turn on the paid partnership label: Instagram \"Add paid partnership label\", YouTube \"My video contains paid promotion\", TikTok branded content (steps below).",
      "Free access to the app counts as payment: the label is still needed.",
    ],
  };
}

/** TikTok's content disclosure setting for posts made in return for a reward (§8 TikTok composer row). */
export const TIKTOK_BRANDED_CONTENT_STEPS: readonly string[] = [
  "On the final Post screen, tap \"More options\".",
  "Turn on \"Disclose post content\".",
  "Choose \"Branded content\" (you're promoting someone else's app in return for something). TikTok adds a \"Paid partnership\" label.",
  "Keep who can view the post on Everyone: branded content can't be private.",
  "Still start the caption with the disclosure line. The label doesn't replace it.",
];

/** "I made this" in the maker's own words. */
export const MAKER_RE =
  /\b(?:I|we)\s+(?:made|built|created|developed|make|build|am building|'m building)\b|\bI'?m\s+the\s+(?:maker|founder|developer|creator|dev|student developer)\b|\bI\s+am\s+the\s+(?:maker|founder|developer|creator)\b|\bmy\s+(?:own\s+)?(?:app|tool|product|project)\b/i;
