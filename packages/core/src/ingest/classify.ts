// §5.2 step 1: URLs are classified by regex (free); anything that isn't a URL is notes.

export type ClassifiedInput =
  | { kind: "github"; owner: string; repo: string; url: string }
  | { kind: "website"; url: string }
  | { kind: "notes"; text: string };

const GITHUB = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:[/?#].*)?$/i;
/** github.com paths that are not repos. */
const GITHUB_RESERVED = new Set(["orgs", "features", "pricing", "about", "topics", "collections", "marketplace", "sponsors", "settings", "login", "signup", "explore"]);
const HOSTLIKE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

export function githubRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

export function parseGithubRepo(raw: string): { owner: string; repo: string } | null {
  const m = GITHUB.exec(raw.trim());
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/i, "");
  if (GITHUB_RESERVED.has(owner.toLowerCase()) || !repo || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** Normalize a pasted website link: add https://, drop the hash, keep path and query. */
export function normalizeWebsite(raw: string): string | null {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) {
    if (!HOSTLIKE.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

export function classifyInput(raw: string): ClassifiedInput {
  const text = raw.trim();
  const gh = parseGithubRepo(text);
  if (gh) return { kind: "github", ...gh, url: githubRepoUrl(gh.owner, gh.repo) };
  if (!/\s/.test(text)) {
    const url = normalizeWebsite(text);
    if (url) return { kind: "website", url };
  }
  return { kind: "notes", text };
}

// ── Source graph: sources point at each other (§5.2 step 1). ──

export interface LinkedSources {
  website: string | null;
  repo: { owner: string; repo: string } | null;
}

/**
 * What a source says about the product's other homes: a repo's homepageUrl → website; a folder's
 * .git/config remote → repo, its package.json homepage → website; a site's github link → repo.
 */
export function linkedSources(hints: {
  homepage?: string | null;
  gitRemote?: string | null;
  packageJson?: { homepage?: unknown; repository?: unknown } | null;
  githubUrl?: string | null;
}): LinkedSources {
  const candidatesWebsite = [hints.homepage, typeof hints.packageJson?.homepage === "string" ? hints.packageJson.homepage : null];
  let website: string | null = null;
  for (const c of candidatesWebsite) {
    if (!c) continue;
    const gh = parseGithubRepo(c);
    if (gh) continue; // a homepage pointing back at the repo isn't a website
    const n = normalizeWebsite(c);
    if (n) {
      website = n;
      break;
    }
  }

  const repoField = hints.packageJson?.repository;
  const repoUrl =
    typeof repoField === "string"
      ? repoField.replace(/^github:/, "https://github.com/")
      : repoField && typeof repoField === "object" && typeof (repoField as { url?: unknown }).url === "string"
        ? ((repoField as { url: string }).url)
        : null;
  let repo: LinkedSources["repo"] = null;
  for (const c of [hints.gitRemote, repoUrl?.replace(/^git\+/, ""), hints.githubUrl]) {
    if (!c) continue;
    const gh = parseGithubRepo(c.replace(/^git@github\.com:/i, "https://github.com/"));
    if (gh) {
      repo = gh;
      break;
    }
  }
  return { website, repo };
}

export function sameSite(a: string, b: string): boolean {
  try {
    const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
    return strip(new URL(a).hostname) === strip(new URL(b).hostname);
  } catch {
    return false;
  }
}

/** URL-safe slug from a product name or host; `taken` gets a numeric suffix appended. */
export function slugify(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "product";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
