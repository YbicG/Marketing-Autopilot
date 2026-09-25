import { describe, expect, it } from "vitest";
import { looksLikeCredentialFile, scanSecrets, SECRET_RULES } from "./secret-scan.ts";

// All fake secrets are assembled at runtime so no literal token appears in this file
// (keeps the repo's own gitleaks hook quiet). Values are obviously fake / deterministic.
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
function fake(n: number, alphabet = ALNUM, seed = 7): string {
  let s = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += alphabet[s % alphabet.length];
  }
  return out;
}

const F = {
  anthropic: "sk-" + "ant-" + "api03-" + fake(90, ALNUM + "-_", 1),
  openai: "sk-" + "proj-" + fake(60, ALNUM, 2),
  openaiLegacy: "sk-" + fake(48, ALNUM, 3),
  awsId: "AKIA" + "FAKE" + fake(12, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 4),
  awsSecret: fake(40, ALNUM + "/+", 5),
  ghp: "ghp" + "_" + fake(36, ALNUM, 6),
  gho: "gho" + "_" + fake(36, ALNUM, 7),
  ghu: "ghu" + "_" + fake(36, ALNUM, 8),
  ghs: "ghs" + "_" + fake(36, ALNUM, 9),
  ghr: "ghr" + "_" + fake(36, ALNUM, 10),
  ghFine: "github" + "_pat_" + fake(22, ALNUM, 11) + "_" + fake(59, ALNUM, 12),
  gitlab: "glpat" + "-" + fake(20, ALNUM, 13),
  slack: "xox" + "b-" + "1234567890" + "-" + "1234567890123" + "-" + fake(24, ALNUM, 14),
  slackHookPath: "T" + fake(8, "ABCDEFGHIJ0123456789", 15) + "/B" + fake(8, "ABCDEFGHIJ0123456789", 16) + "/" + fake(24, ALNUM, 17),
  stripeLive: "sk" + "_live_" + fake(24, ALNUM, 18),
  stripeRestricted: "rk" + "_live_" + fake(24, ALNUM, 19),
  stripeTest: "sk" + "_test_" + fake(24, ALNUM, 20),
  gcp: "AI" + "za" + fake(35, ALNUM + "-_", 21),
  gocspx: "GOC" + "SPX-" + fake(28, ALNUM, 22),
  jwt:
    "ey" + "J" + fake(30, ALNUM, 23) + "." + "ey" + "J" + fake(40, ALNUM, 24) + "." + fake(43, ALNUM + "-_", 25),
  twilio: "S" + "K" + fake(32, HEX, 26),
  sendgrid: "S" + "G." + fake(22, ALNUM, 27) + "." + fake(43, ALNUM, 28),
  resend: "r" + "e_" + "Ab12Cd34" + "_" + fake(24, ALNUM, 29),
  npm: "np" + "m_" + fake(36, ALNUM, 30),
  discord: "M" + fake(25, ALNUM, 31) + "." + fake(6, ALNUM, 32) + "." + fake(38, ALNUM, 33),
  pgPass: "Pg" + fake(14, ALNUM, 34),
  generic: "Zq9" + fake(21, ALNUM, 35),
};

function pem(label = "RSA PRIVATE KEY", eol = "\n"): string {
  const body = Array.from({ length: 5 }, (_, i) => fake(64, ALNUM + "+/", 40 + i)).join(eol);
  return `-----BEGIN ${label}-----${eol}${body}${eol}-----END ${label}-----`;
}

function expectRedacted(input: string, secret: string, rule: string) {
  const r = scanSecrets(input);
  expect(r.redacted).not.toContain(secret);
  expect(r.redacted).toContain(`[REDACTED:${rule}]`);
  expect(r.hits.map((h) => h.rule)).toContain(rule);
  return r;
}

describe("scanSecrets — one positive case per rule", () => {
  it.each<[string, string, string]>([
    ["anthropic-api-key", `ANTHROPIC_API_KEY=${F.anthropic}`, F.anthropic],
    ["openai-api-key", `key: ${F.openai}`, F.openai],
    ["openai-api-key", `use ${F.openaiLegacy} here`, F.openaiLegacy],
    ["aws-access-key-id", `id ${F.awsId} ok`, F.awsId],
    ["aws-secret-access-key", `aws_secret_access_key = ${F.awsSecret}`, F.awsSecret],
    ["github-pat", `token ${F.ghp}`, F.ghp],
    ["github-oauth", `x ${F.gho}`, F.gho],
    ["github-app-token", `x ${F.ghu}`, F.ghu],
    ["github-app-token", `x ${F.ghs}`, F.ghs],
    ["github-refresh-token", `x ${F.ghr}`, F.ghr],
    ["github-fine-grained-pat", `x ${F.ghFine}`, F.ghFine],
    ["gitlab-pat", `x ${F.gitlab}`, F.gitlab],
    ["slack-token", `bot ${F.slack}`, F.slack],
    ["slack-webhook-url", `post to https://hooks.slack.com/services/${F.slackHookPath}`, F.slackHookPath],
    ["stripe-secret-key", `x ${F.stripeLive}`, F.stripeLive],
    ["stripe-secret-key", `x ${F.stripeRestricted}`, F.stripeRestricted],
    ["stripe-secret-key", `x ${F.stripeTest}`, F.stripeTest],
    ["gcp-api-key", `maps key ${F.gcp}`, F.gcp],
    ["google-oauth-client-secret", `x ${F.gocspx}`, F.gocspx],
    ["jwt", `Authorization: Bearer ${F.jwt}`, F.jwt],
    ["twilio-api-key", `sid ${F.twilio}`, F.twilio],
    ["sendgrid-api-key", `x ${F.sendgrid}`, F.sendgrid],
    ["resend-api-key", `x ${F.resend}`, F.resend],
    ["npm-access-token", `//registry.npmjs.org/:_authToken=${F.npm}`, F.npm],
    ["discord-bot-token", `bot ${F.discord}`, F.discord],
    ["generic-secret", `CLIENT_SECRET=${F.generic}`, F.generic],
  ])("%s", (rule, input, secret) => {
    expectRedacted(input, secret, rule);
  });

  it("connection URIs: redacts only the password, keeps scheme/user/host visible", () => {
    const cases: [string, string][] = [
      ["postgres-uri-password", `postgresql://app:${F.pgPass}@db.internal:5432/app`],
      ["mysql-uri-password", `mysql://root:${F.pgPass}@mysql.local:3306/shop`],
      ["mongodb-uri-password", `mongodb+srv://svc:${F.pgPass}@cluster0.example.net/db`],
      ["redis-uri-password", `rediss://default:${F.pgPass}@cache.internal:6380`],
    ];
    for (const [rule, uri] of cases) {
      const r = expectRedacted(`DATABASE_URL=${uri}`, F.pgPass, rule);
      const [scheme, rest] = uri.split("://") as [string, string];
      const user = rest.split(":")[0] ?? "";
      const host = rest.split("@")[1] ?? "";
      expect(r.redacted).toBe(`DATABASE_URL=${scheme}://${user}:[REDACTED:${rule}]@${host}`);
      expect(r.hits).toHaveLength(1);
    }
  });

  it("service-account JSON private_key value", () => {
    const escapedPem = pem("PRIVATE KEY").replace(/\n/g, "\\n");
    const json = `{\n  "type": "service_account",\n  "private_key": "${escapedPem}\\n",\n  "client_email": "bot@proj.iam.gserviceaccount.com"\n}`;
    const r = scanSecrets(json);
    expect(r.redacted).not.toContain("-----BEGIN");
    expect(r.redacted).toContain('"type": "service_account"');
    expect(r.redacted).toContain("bot@proj.iam.gserviceaccount.com");
    expect(r.hits[0]?.line).toBe(3);
    expect(["private-key", "gcp-service-account-private-key"]).toContain(r.hits[0]?.rule);
  });

  it("every public rule id has a positive case above", () => {
    const covered = new Set([
      "private-key",
      "gcp-service-account-private-key",
      "anthropic-api-key",
      "openai-api-key",
      "aws-access-key-id",
      "aws-secret-access-key",
      "github-fine-grained-pat",
      "github-pat",
      "github-oauth",
      "github-app-token",
      "github-refresh-token",
      "gitlab-pat",
      "slack-webhook-url",
      "slack-token",
      "stripe-secret-key",
      "gcp-api-key",
      "google-oauth-client-secret",
      "jwt",
      "sendgrid-api-key",
      "twilio-api-key",
      "resend-api-key",
      "npm-access-token",
      "discord-bot-token",
      "postgres-uri-password",
      "mysql-uri-password",
      "mongodb-uri-password",
      "redis-uri-password",
      "generic-secret",
    ]);
    expect(new Set(SECRET_RULES.map((r) => r.id))).toEqual(covered);
  });

  it("gcp service-account private_key without PEM framing still redacts", () => {
    const val = fake(80, ALNUM + "+/", 60);
    expectRedacted(`{"private_key": "${val}"}`, val, "gcp-service-account-private-key");
  });
});

describe("PEM private key blocks", () => {
  it("redacts the whole multi-line block and keeps surrounding text", () => {
    const block = pem();
    const input = `Deploy key below:\n\n${block}\n\nDone.`;
    const r = scanSecrets(input);
    expect(r.redacted).toBe("Deploy key below:\n\n[REDACTED:private-key]\n\nDone.");
    expect(r.hits).toEqual([{ rule: "private-key", line: 3 }]);
  });

  it("handles OpenSSH / EC labels and CRLF", () => {
    for (const label of ["OPENSSH PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY"]) {
      const r = scanSecrets(`a\r\n${pem(label, "\r\n")}\r\nb`);
      expect(r.redacted).toBe("a\r\n[REDACTED:private-key]\r\nb");
    }
  });

  it("redacts a truncated block with no END line", () => {
    const body = fake(64, ALNUM + "+/", 70);
    const r = scanSecrets(`-----BEGIN RSA PRIVATE KEY-----\n${body}\n`);
    expect(r.redacted).not.toContain(body);
  });

  it("does not flag a public key / certificate", () => {
    const pub = `-----BEGIN PUBLIC KEY-----\n${fake(64, ALNUM, 71)}\n-----END PUBLIC KEY-----`;
    expect(scanSecrets(pub).hits).toEqual([]);
  });
});

describe("realistic documents", () => {
  const envBlock = [
    "# Setup",
    "",
    "Copy this into `.env`:",
    "",
    "```env",
    "NODE_ENV=production",
    "PORT=3000",
    `ANTHROPIC_API_KEY=${F.anthropic}`,
    `OPENAI_API_KEY="${F.openai}"`,
    `DATABASE_URL=postgres://app:${F.pgPass}@db.internal:5432/app`,
    `STRIPE_SECRET_KEY=${F.stripeLive}`,
    `SESSION_SECRET='${F.generic}'`,
    "export REDIS_PASSWORD=" + "Rd" + fake(18, ALNUM, 80),
    "LOG_LEVEL=info",
    "```",
    "",
    "Then run `pnpm dev`.",
  ].join("\n");

  it("redacts each secret in an .env block embedded in markdown and reports line numbers", () => {
    const r = scanSecrets(envBlock);
    expect(r.hits).toEqual([
      { rule: "anthropic-api-key", line: 8 },
      { rule: "openai-api-key", line: 9 },
      { rule: "postgres-uri-password", line: 10 },
      { rule: "stripe-secret-key", line: 11 },
      { rule: "generic-secret", line: 12 },
      { rule: "generic-secret", line: 13 },
    ]);
    expect(r.redacted).toContain("ANTHROPIC_API_KEY=[REDACTED:anthropic-api-key]\n");
    expect(r.redacted).toContain('OPENAI_API_KEY="[REDACTED:openai-api-key]"');
    expect(r.redacted).toContain("postgres://app:[REDACTED:postgres-uri-password]@db.internal:5432/app");
    expect(r.redacted).toContain("SESSION_SECRET='[REDACTED:generic-secret]'");
    expect(r.redacted).toContain("NODE_ENV=production\nPORT=3000\n");
    expect(r.redacted).toContain("Then run `pnpm dev`.");
  });

  it("handles CRLF input identically (line numbers + CR preserved)", () => {
    const crlf = envBlock.replace(/\n/g, "\r\n");
    const r = scanSecrets(crlf);
    const lf = scanSecrets(envBlock);
    expect(r.hits).toEqual(lf.hits);
    expect(r.redacted).toBe(lf.redacted.replace(/\n/g, "\r\n"));
    expect(r.redacted).toContain("ANTHROPIC_API_KEY=[REDACTED:anthropic-api-key]\r\n");
  });

  it("is idempotent: scanning redacted output yields no new hits and no change", () => {
    const once = scanSecrets(envBlock + "\n" + pem() + "\n" + Object.values(F).join("\n"));
    expect(once.hits.length).toBeGreaterThan(10);
    const twice = scanSecrets(once.redacted);
    expect(twice.hits).toEqual([]);
    expect(twice.redacted).toBe(once.redacted);
  });

  it("generic rule works for YAML and JSON", () => {
    const yaml = `auth:\n  client_secret: ${F.generic}\n  api_key: "${F.generic}"\n`;
    const r1 = scanSecrets(yaml);
    expect(r1.hits).toEqual([
      { rule: "generic-secret", line: 2 },
      { rule: "generic-secret", line: 3 },
    ]);
    const json = `{"apiKey": "${F.generic}", "name": "demo"}`;
    const r2 = scanSecrets(json);
    expect(r2.redacted).toBe(`{"apiKey": "[REDACTED:generic-secret]", "name": "demo"}`);
  });

  it("reports the correct line for hits on the first and later lines", () => {
    const r = scanSecrets(`${F.ghp}\n\n\nfoo ${F.npm}`);
    expect(r.hits).toEqual([
      { rule: "github-pat", line: 1 },
      { rule: "npm-access-token", line: 4 },
    ]);
  });
});

describe("false positives", () => {
  it.each([
    "API_KEY=changeme",
    "API_KEY=your-key-here",
    "API_KEY=your_api_key_here",
    "SECRET_KEY=xxxxxxxxxxxxxxxx",
    "SECRET_KEY=XXXXXXXXXXXX",
    "TOKEN=<your-token>",
    "TOKEN=${GITHUB_TOKEN}",
    "password: ${{ secrets.DB_PASSWORD }}",
    "DB_PASSWORD=",
    'PASSWORD=""',
    "AUTH_ENABLED=true",
    "USE_AUTH=false",
    "API_KEY=example-api-key-123",
    "CLIENT_SECRET=my-super-secret-value",
    "ACCESS_TOKEN=********",
    "SECRET=replace-me",
    "API_KEY=sk-...abcd",
    "PRIVATE_KEY_PATH=./keys/dev.pem",
    "AUTH_URL=https://auth.example.com/callback",
    "API_KEY=process.env.API_KEY",
    "DATABASE_URL=postgres://user:password@localhost:5432/db",
    "REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379",
  ])("does not flag placeholder %s", (input) => {
    expect(scanSecrets(input).hits).toEqual([]);
  });

  it("does not flag ordinary prose and code mentioning tokens/passwords", () => {
    const text = [
      "The token bucket algorithm refills tokens at a fixed rate.",
      "Enter your password: it must be at least 12 characters.",
      "Authentication: we use OAuth 2.0 with PKCE; the access token expires after 1 hour.",
      "author: Jane Doe",
      'author: "Jane Doe <jane@example.com>"',
      "const token = await getToken(req);",
      "const password = z.string().min(12);",
      "interface Session { accessToken: AccessTokenResponse; refreshToken?: string }",
      "this.token = token;",
      "if (secret === undefined) throw new Error('missing secret');",
      "maxTokens: 4096,",
      "max_output_tokens=8192",
      "tokenizer: cl100k_base",
      "passwordHash: bcrypt.hashSync(password, 10)",
      "const apiKey = config.get('apiKey');",
      "The sk-learn library is great for ML.",
      "Use git and eyJhbG... style strings for JWTs.",
      "Read more at https://github.com/org/repo#auth-token-setup",
      "Colors: #AKIAFFFF and ORDER-1234567890",
      "import re_compile_all_patterns_now from 'x'",
    ].join("\n");
    const r = scanSecrets(text);
    expect(r.hits).toEqual([]);
    expect(r.redacted).toBe(text);
  });

  it("empty input", () => {
    expect(scanSecrets("")).toEqual({ redacted: "", hits: [] });
  });
});

describe("performance", () => {
  it("stays fast on adversarial inputs (no catastrophic backtracking)", () => {
    const inputs = [
      "a".repeat(200_000),
      "TOKEN=" + "a=".repeat(50_000),
      "-----BEGIN RSA PRIVATE KEY-----" + "A".repeat(100_000),
      ("postgres://" + "u:".repeat(1000)).repeat(20),
      "eyJ" + "a".repeat(5000) + ".eyJ" + "b".repeat(5000) + ".",
      ("x".repeat(80) + ":" + " ").repeat(3000),
      "sk-".repeat(50_000),
    ];
    const t0 = performance.now();
    for (const s of inputs) scanSecrets(s);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe("looksLikeCredentialFile", () => {
  it("true for a Google service-account JSON", () => {
    const sa = JSON.stringify(
      {
        type: "service_account",
        project_id: "demo-project",
        private_key_id: fake(40, HEX, 90),
        private_key: pem("PRIVATE KEY") + "\n",
        client_email: "svc@demo-project.iam.gserviceaccount.com",
      },
      null,
      2,
    );
    expect(looksLikeCredentialFile("demo-project-1234.json", sa)).toBe(true);
    // Even if renamed or truncated
    expect(looksLikeCredentialFile("notes.txt", sa.slice(0, 120))).toBe(true);
  });

  it("true for an OAuth client_secret JSON and a raw PEM key", () => {
    const oauth = JSON.stringify({ installed: { client_id: "abc.apps.googleusercontent.com", client_secret: F.gocspx } });
    expect(looksLikeCredentialFile("client_secret.json", oauth)).toBe(true);
    expect(looksLikeCredentialFile("id_rsa", pem("OPENSSH PRIVATE KEY"))).toBe(true);
  });

  it("false for package.json and ordinary JSON/markdown", () => {
    const pkg = JSON.stringify(
      { name: "@mkt/core", version: "0.0.0", type: "module", scripts: { test: "vitest run" }, dependencies: { zod: "^4" } },
      null,
      2,
    );
    expect(looksLikeCredentialFile("package.json", pkg)).toBe(false);
    expect(looksLikeCredentialFile("tsconfig.json", '{ "compilerOptions": { "strict": true } }')).toBe(false);
    expect(looksLikeCredentialFile("README.md", "# Title\nSee the service_account docs.")).toBe(false);
  });
});
