import { describe, expect, it } from "vitest";
import {
  FOLDER_LIMITS,
  FolderManifest,
  classifyIntakeDir,
  classifyIntakePath,
  gitRemoteFromConfig,
  isCredentialContent,
  planIntake,
  stripRootName,
} from "./folder-intake.ts";

const KB = 1024;
const MB = 1024 * KB;

describe("classifyIntakePath", () => {
  const cases: [string, string][] = [
    // included: kind
    ["README.md", "readme"],
    ["readme", "readme"],
    ["ReadMe.rst", "readme"],
    ["CHANGELOG.md", "doc"],
    ["guide.mdx", "doc"],
    ["package.json", "package_json"],
    ["app.json", "app_json"],
    ["app.config.json", "app_json"],
    ["manifest.json", "app_json"],
    [".git/config", "git_config"],
    ["docs/intro.md", "doc"],
    ["docs/a/b/c.md", "doc"],
    ["docs/README.md", "doc"],
    ["public/og.png", "image"],
    ["screenshots/home.JPG", "image"],
    ["assets/img/icons/x/logo.webp", "image"],
    ["docs/img/a.gif", "image"],
    // excluded: reason
    ["apps/x/.env", "denied"],
    [".env", "denied"],
    [".env.example", "denied"],
    [".env.local", "denied"],
    ["node_modules/foo/README.md", "denied"],
    ["docs/node_modules/x.md", "denied"],
    ["dist/README.md", "denied"],
    ["id_rsa", "denied"],
    ["id_rsa.pub", "denied"],
    ["id_ed25519", "denied"],
    ["id_foo", "denied"],
    ["public/server.pem", "denied"],
    ["public/tls.key", "denied"],
    ["cert.p12", "denied"],
    ["android.keystore", "denied"],
    ["credentials.json", "denied"],
    ["secrets.md", "denied"],
    ["secrets/README.md", "denied"],
    ["public/data.sqlite", "denied"],
    ["app.db", "denied"],
    ["docs/a/b/c/d/e.md", "not_allowlisted"],
    ["docs/a/b/c/d.md", "not_allowlisted"],
    ["src/index.ts", "not_allowlisted"],
    ["src/README.md", "not_allowlisted"],
    ["apps/web/package.json", "not_allowlisted"],
    [".git/HEAD", "not_allowlisted"],
    ["public/a/b/c/d/e.png", "not_allowlisted"],
    ["public/logo.svg", "not_allowlisted"],
    ["tsconfig.json", "not_allowlisted"],
    ["../README.md", "not_allowlisted"],
  ];
  it.each(cases)("%s -> %s", (path, expected) => {
    const d = classifyIntakePath(path, 100);
    expect(d.include ? d.kind : d.reason).toBe(expected);
  });

  it("normalizes backslashes and leading ./", () => {
    const d = classifyIntakePath(".\\docs\\intro.md", 10);
    expect(d).toMatchObject({ path: "docs/intro.md", include: true, kind: "doc" });
  });

  it("enforces the per-file size limit", () => {
    expect(classifyIntakePath("README.md", FOLDER_LIMITS.maxFileBytes).include).toBe(true);
    expect(classifyIntakePath("README.md", FOLDER_LIMITS.maxFileBytes + 1)).toMatchObject({
      include: false,
      reason: "too_large",
    });
    // denylist still wins over size
    expect(classifyIntakePath(".env", 10 * MB)).toMatchObject({ include: false, reason: "denied" });
  });
});

describe("classifyIntakeDir / stripRootName", () => {
  it("decides which directories to walk", () => {
    expect(classifyIntakeDir("")).toBe("descend");
    expect(classifyIntakeDir("node_modules")).toBe("denied");
    expect(classifyIntakeDir("docs/.next")).toBe("denied");
    expect(classifyIntakeDir("src")).toBe("not_allowlisted");
    expect(classifyIntakeDir(".git")).toBe("descend");
    expect(classifyIntakeDir(".git/objects")).toBe("not_allowlisted");
    expect(classifyIntakeDir("docs/a/b/c")).toBe("descend");
    expect(classifyIntakeDir("public/a/b/c/d")).toBe("not_allowlisted");
  });
  it("strips the root folder name", () => {
    expect(stripRootName("my-app/docs/a.md", "my-app")).toBe("docs/a.md");
    expect(stripRootName("other/docs/a.md", "my-app")).toBe("other/docs/a.md");
  });
});

describe("planIntake", () => {
  it("splits included and skipped with reasons", () => {
    const plan = planIntake([
      { path: "README.md", size: 5 * KB },
      { path: "src/index.ts", size: 1 * KB },
      { path: "node_modules/x/README.md", size: 1 * KB },
      { path: "public/huge.png", size: 3 * MB },
    ]);
    expect(plan.included.map((f) => f.path)).toEqual(["README.md"]);
    expect(plan.totalBytes).toBe(5 * KB);
    expect(plan.skipped.map((s) => [s.path, s.reason])).toEqual([
      ["src/index.ts", "not_allowlisted"],
      ["node_modules/x/README.md", "denied"],
      ["public/huge.png", "too_large"],
    ]);
  });

  it("keeps by priority when over the total limit", () => {
    const images = Array.from({ length: 5 }, (_, i) => ({ path: `public/s${i}.png`, size: 2 * MB }));
    const plan = planIntake([
      ...images,
      { path: "docs/guide.md", size: 100 * KB },
      { path: "CHANGELOG.md", size: 100 * KB },
      { path: ".git/config", size: 1 * KB },
      { path: "package.json", size: 2 * KB },
      { path: "README.md", size: 50 * KB },
    ]);
    expect(plan.included.map((f) => f.path)).toEqual([
      "README.md",
      "package.json",
      ".git/config",
      "CHANGELOG.md",
      "docs/guide.md",
      "public/s0.png",
      "public/s1.png",
      "public/s2.png",
      "public/s3.png",
    ]);
    expect(plan.totalBytes).toBeLessThanOrEqual(FOLDER_LIMITS.maxTotalBytes);
    expect(plan.skipped).toEqual([{ path: "public/s4.png", include: false, reason: "over_total" }]);
  });

  it("caps the file count", () => {
    const files = Array.from({ length: 250 }, (_, i) => ({ path: `docs/p${String(i).padStart(3, "0")}.md`, size: 10 }));
    const plan = planIntake(files);
    expect(plan.included).toHaveLength(FOLDER_LIMITS.maxFiles);
    expect(plan.skipped.filter((s) => s.reason === "over_total")).toHaveLength(50);
  });

  it("dedupes repeated paths", () => {
    const plan = planIntake([
      { path: "README.md", size: 1 },
      { path: "./README.md", size: 1 },
    ]);
    expect(plan.included).toHaveLength(1);
  });
});

describe("isCredentialContent", () => {
  it("flags service-account and private-key JSON", () => {
    expect(isCredentialContent('{"type": "service_account", "project_id": "x"}')).toBe(true);
    expect(isCredentialContent('{"type":"service_account"}')).toBe(true);
    expect(isCredentialContent('{"private_key": "-----BEGIN..."}')).toBe(true);
    expect(isCredentialContent("-----BEGIN RSA PRIVATE KEY-----\nabc")).toBe(true);
  });
  it("passes normal package.json", () => {
    expect(isCredentialContent('{"name":"app","type":"module","scripts":{"build":"next build"}}')).toBe(false);
  });
});

describe("gitRemoteFromConfig", () => {
  const cfg = (url: string, remote = "origin") =>
    `[core]\n\trepositoryformatversion = 0\n[remote "${remote}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${remote}/*\n[branch "main"]\n\tremote = ${remote}\n`;

  it.each([
    ["git@github.com:acme/app.git", "https://github.com/acme/app"],
    ["git@github.com:acme/app", "https://github.com/acme/app"],
    ["ssh://git@github.com/acme/app.git", "https://github.com/acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "https://github.com/acme/app"],
    ["https://github.com/acme/app.git", "https://github.com/acme/app"],
    ["https://github.com/acme/app", "https://github.com/acme/app"],
    ["https://ghp_abc123SECRET@github.com/acme/app.git", "https://github.com/acme/app"],
    ["https://user:tok3n@github.com/acme/app.git", "https://github.com/acme/app"],
    ["https://www.github.com/Acme/App/", "https://github.com/Acme/App"],
    ["git://github.com/acme/app.git", "https://github.com/acme/app"],
    ["https://oauth2:glpat-xyz@gitlab.com/group/sub/app.git", "https://gitlab.com/group/sub/app"],
    ["git@bitbucket.org:team/app.git", "https://bitbucket.org/team/app"],
  ])("%s -> %s", (url, expected) => {
    const out = gitRemoteFromConfig(cfg(url));
    expect(out).toBe(expected);
    expect(out).not.toMatch(/SECRET|tok3n|glpat|@/);
  });

  it("prefers origin over other remotes", () => {
    const text = cfg("git@github.com:fork/app.git", "upstream") + cfg("git@github.com:me/app.git");
    expect(gitRemoteFromConfig(text)).toBe("https://github.com/me/app");
  });

  it("returns null without a usable remote", () => {
    expect(gitRemoteFromConfig("[core]\n\tbare = false\n")).toBeNull();
    expect(gitRemoteFromConfig(cfg("/home/me/repos/app.git"))).toBeNull();
    expect(gitRemoteFromConfig(cfg("C:\\repos\\app"))).toBeNull();
    expect(gitRemoteFromConfig("")).toBeNull();
  });
});

describe("FolderManifest", () => {
  it("accepts a valid manifest", () => {
    const ok = FolderManifest.safeParse({
      rootName: "my-app",
      files: [
        { path: "README.md", size: 100, kind: "readme" },
        { path: "public/og.png", size: 2000, kind: "image" },
      ],
    });
    expect(ok.success).toBe(true);
  });
  it("rejects denied, mis-kinded, oversized and duplicate files", () => {
    const passes = (files: unknown[]) => FolderManifest.safeParse({ rootName: "x", files }).success;
    expect(passes([{ path: ".env", size: 10, kind: "doc" }])).toBe(false);
    expect(passes([{ path: "src/a.ts", size: 10, kind: "doc" }])).toBe(false);
    expect(passes([{ path: "README.md", size: 10, kind: "doc" }])).toBe(false);
    expect(passes([{ path: "README.md", size: 3 * MB, kind: "readme" }])).toBe(false);
    expect(
      passes([
        { path: "README.md", size: 10, kind: "readme" },
        { path: "README.md", size: 10, kind: "readme" },
      ]),
    ).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => ({ path: `public/${i}.png`, size: 2 * MB, kind: "image" }));
    expect(passes(six)).toBe(false);
  });
});
