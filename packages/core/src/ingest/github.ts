import { scanSecrets } from "../security/secret-scan.ts";
import type { FetchText } from "./types.ts";

export interface GithubRepoData {
  fullName: string;
  description: string | null;
  homepage: string | null;
  stars: number;
  topics: string[];
  license: string | null;
  language: string | null;
  pushedAt: string | null;
  readme: string | null;
  releases: { name: string; tag: string; publishedAt: string | null; body: string }[];
  secretHits: number;
}

export class GithubUnavailable extends Error {
  readonly code = "github_unavailable";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubUnavailable";
  }
}

const API = "https://api.github.com";
const MAX_README = 60_000;

/**
 * Public repo facts over unauthenticated REST (or GITHUB_TOKEN when set). Everything goes through
 * safe-fetch like any other URL. README and release notes are secret-scanned before they're returned.
 */
export async function fetchGithubRepo(
  fetchText: FetchText,
  owner: string,
  repo: string,
  token?: string,
): Promise<GithubRepoData> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "mkt-autopilot",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const get = async (path: string, accept?: string) => {
    const res = await fetchText(`${API}${path}`, { headers: accept ? { ...headers, accept } : headers, timeoutMs: 15_000 });
    return res;
  };

  const metaRes = await get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (metaRes.status === 404) {
    throw new GithubUnavailable("That GitHub repo is private or doesn't exist. Drop the project folder instead.", 404);
  }
  if (metaRes.status === 403 || metaRes.status === 429) {
    throw new GithubUnavailable("GitHub is rate-limiting us right now. The run continues without the repo.", metaRes.status);
  }
  if (metaRes.status >= 400) throw new GithubUnavailable(`GitHub answered ${metaRes.status}.`, metaRes.status);
  const meta = JSON.parse(metaRes.text) as Record<string, unknown>;

  let secretHits = 0;
  let readme: string | null = null;
  const readmeRes = await get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`, "application/vnd.github.raw+json");
  if (readmeRes.status < 300) {
    const scanned = scanSecrets(readmeRes.text.slice(0, MAX_README));
    readme = scanned.redacted;
    secretHits += scanned.hits.length;
  }

  const releases: GithubRepoData["releases"] = [];
  const relRes = await get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=5`);
  if (relRes.status < 300) {
    for (const r of JSON.parse(relRes.text) as Record<string, unknown>[]) {
      const scanned = scanSecrets(String(r.body ?? "").slice(0, 4_000));
      secretHits += scanned.hits.length;
      releases.push({
        name: String(r.name ?? r.tag_name ?? ""),
        tag: String(r.tag_name ?? ""),
        publishedAt: typeof r.published_at === "string" ? r.published_at : null,
        body: scanned.redacted,
      });
    }
  }

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    fullName: String(meta.full_name ?? `${owner}/${repo}`),
    description: str(meta.description),
    homepage: str(meta.homepage),
    stars: Number(meta.stargazers_count ?? 0),
    topics: Array.isArray(meta.topics) ? meta.topics.map(String) : [],
    license: str((meta.license as { spdx_id?: unknown } | null)?.spdx_id),
    language: str(meta.language),
    pushedAt: str(meta.pushed_at),
    readme,
    releases,
    secretHits,
  };
}

export function repoMetaText(d: GithubRepoData): string {
  return [
    `Repository: ${d.fullName}`,
    d.description && `Description: ${d.description}`,
    d.homepage && `Homepage: ${d.homepage}`,
    `Stars: ${d.stars}`,
    d.topics.length ? `Topics: ${d.topics.join(", ")}` : null,
    d.license && `License: ${d.license}`,
    d.language && `Main language: ${d.language}`,
    d.pushedAt && `Last push: ${d.pushedAt}`,
    ...d.releases.map((r) => `Release ${r.tag}${r.publishedAt ? ` (${r.publishedAt.slice(0, 10)})` : ""}: ${r.name}\n${r.body}`),
  ]
    .filter(Boolean)
    .join("\n");
}
