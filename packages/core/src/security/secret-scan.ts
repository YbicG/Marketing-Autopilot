/**
 * Gitleaks-style secret scanner for all ingested text (website pages, project-folder docs,
 * GitHub READMEs, notes). Runs BEFORE text is stored or placed in a prompt; matches are
 * replaced in place with `[REDACTED:<rule-id>]`, keeping the surrounding text.
 *
 * Design notes:
 * - Every pattern uses bounded quantifiers and character classes that can't overlap their
 *   delimiters, so matching is linear-ish (no catastrophic backtracking).
 * - Candidates from all rules are collected against the original text, then resolved:
 *   specific rules win over the generic assignment rule, earlier rules win ties.
 * - Idempotent: any candidate whose value already contains a redaction marker is ignored,
 *   so re-scanning redacted output yields no new hits.
 */

export interface SecretHit {
  rule: string;
  /** 1-based line of the match start. */
  line: number;
}

export interface ScanResult {
  redacted: string;
  hits: SecretHit[];
}

interface PatternRule {
  id: string;
  description: string;
  /** Must carry the `g` and `d` flags. */
  re: RegExp;
  /** Capture group holding the secret value; 0 (whole match) when omitted. */
  group?: number;
  /** Extra filter on the captured value to reduce false positives. */
  accept?: (value: string) => boolean;
}

const MARKER = "[REDACTED:";

const hasDigit = (s: string) => /[0-9]/.test(s);
const hasUpper = (s: string) => /[A-Z]/.test(s);
const hasLower = (s: string) => /[a-z]/.test(s);

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER_WORDS = new Set([
  "changeme",
  "change-me",
  "change_me",
  "password",
  "passwd",
  "pass",
  "secret",
  "token",
  "example",
  "sample",
  "dummy",
  "placeholder",
  "redacted",
  "null",
  "none",
  "nil",
  "undefined",
  "true",
  "false",
  "yes",
  "no",
  "todo",
  "tbd",
  "test",
]);

/** Obvious non-secret values: templates, masks, `your-key-here`, booleans, etc. */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  const lower = v.toLowerCase();
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  // Template / reference syntax: ${VAR}, $VAR, {{ x }}, <your-key>, %VAR%, [value], !vault, *, &anchor
  if (/^[$<{%[!*&@]/.test(v)) return true;
  if (/^(?:process\.env|import\.meta\.env|os\.environ|env\.|secrets\.)/i.test(v)) return true;
  // Masks: xxxx, ****, ...., ----, 0000
  if (/^([xX*.#\-_0•])\1*$/.test(v)) return true;
  if (/^x{3,}/i.test(v) && /^[x\-_]+$/i.test(v)) return true;
  if (/^(?:your|insert|enter|put|add)[-_ ]/.test(lower) || /^your[a-z]/.test(lower)) return true;
  if (/(?:^|[-_ ])here$/.test(lower)) return true;
  if (/(?:^|[-_ ])(?:example|placeholder|changeme|redacted|dummy|sample|replace[-_ ]?me|insert|fake)(?:$|[-_ ])/i.test(lower))
    return true;
  if (lower.includes("example")) return true;
  if (/^\.{3}|\.{3}$/.test(v)) return true; // truncated like "sk-...abcd"
  return false;
}

/** For credentials inside connection URIs: only skip explicit placeholders. */
function isUriPasswordPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (["password", "pass", "passwd", "pwd", "changeme", "secret", "xxx"].includes(lower)) return true;
  if (/^[$<{%*]/.test(value)) return true;
  if (/^([x*])\1*$/i.test(value)) return true;
  return false;
}

const PATTERN_RULES: PatternRule[] = [
  {
    id: "private-key",
    description: "PEM private key block (RSA/EC/DSA/OpenSSH/PGP/PKCS#8)",
    re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,20000}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----|(?:[A-Za-z0-9+/=\s]|\\[nr]){0,20000})/dg,
  },
  {
    id: "gcp-service-account-private-key",
    description: 'Service-account JSON "private_key" value',
    re: /"private_key"[ \t]{0,10}:[ \t]{0,10}"([^"\r\n]{20,20000})"/dg,
    group: 1,
  },
  {
    id: "anthropic-api-key",
    description: "Anthropic API / admin key (sk-ant-...)",
    re: /(?<![A-Za-z0-9_-])sk-ant-[a-z]{2,10}[0-9]{0,3}-[A-Za-z0-9_-]{20,300}/dg,
  },
  {
    id: "openai-api-key",
    description: "OpenAI API key (sk-..., sk-proj-..., sk-svcacct-...)",
    re: /(?<![A-Za-z0-9_-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,300}/dg,
    accept: (v) => hasDigit(v) && (hasUpper(v) || hasLower(v)) && shannonEntropy(v) >= 3,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key id (AKIA/ASIA/...)",
    re: /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])/dg,
  },
  {
    id: "aws-secret-access-key",
    description: "AWS secret access key in an assignment",
    re: /(?<![A-Za-z0-9])aws[A-Za-z0-9_.-]{0,30}["']?[ \t]{0,4}[:=][ \t]{0,4}["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/dgi,
    group: 1,
  },
  {
    id: "github-fine-grained-pat",
    description: "GitHub fine-grained personal access token",
    re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{50,255}/dg,
  },
  {
    id: "github-pat",
    description: "GitHub personal access token (ghp_)",
    re: /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{36,255}/dg,
  },
  {
    id: "github-oauth",
    description: "GitHub OAuth access token (gho_)",
    re: /(?<![A-Za-z0-9_])gho_[A-Za-z0-9]{36,255}/dg,
  },
  {
    id: "github-app-token",
    description: "GitHub app user-to-server / server-to-server token (ghu_, ghs_)",
    re: /(?<![A-Za-z0-9_])gh[us]_[A-Za-z0-9]{36,255}/dg,
  },
  {
    id: "github-refresh-token",
    description: "GitHub refresh token (ghr_)",
    re: /(?<![A-Za-z0-9_])ghr_[A-Za-z0-9]{36,255}/dg,
  },
  {
    id: "gitlab-pat",
    description: "GitLab personal access token (glpat-)",
    re: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,64}/dg,
  },
  {
    id: "slack-webhook-url",
    description: "Slack incoming webhook URL",
    re: /hooks\.slack\.com\/(?:services|workflows|triggers)\/([A-Za-z0-9+/_-]{20,200})/dg,
    group: 1,
  },
  {
    id: "slack-token",
    description: "Slack bot/user/app token (xoxb-, xoxp-, ...)",
    re: /(?<![A-Za-z0-9_-])xox[abprs]-[0-9A-Za-z-]{10,250}/dg,
  },
  {
    id: "stripe-secret-key",
    description: "Stripe secret or restricted key (sk_live_, rk_live_, sk_test_, rk_test_)",
    re: /(?<![A-Za-z0-9_])[sr]k_(?:live|test)_[A-Za-z0-9]{10,247}/dg,
  },
  {
    id: "gcp-api-key",
    description: "Google API key (AIza...)",
    re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/dg,
  },
  {
    id: "google-oauth-client-secret",
    description: "Google OAuth client secret (GOCSPX-)",
    re: /(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{20,40}/dg,
  },
  {
    id: "jwt",
    description: "JSON Web Token",
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,4000}\.eyJ[A-Za-z0-9_-]{10,8000}\.[A-Za-z0-9_-]{10,2000}/dg,
  },
  {
    id: "sendgrid-api-key",
    description: "SendGrid API key (SG.)",
    re: /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{30,64}/dg,
  },
  {
    id: "twilio-api-key",
    description: "Twilio API key SID (SK + 32 hex)",
    re: /(?<![A-Za-z0-9])SK[0-9a-fA-F]{32}(?![A-Za-z0-9])/dg,
  },
  {
    id: "resend-api-key",
    description: "Resend API key (re_)",
    re: /(?<![A-Za-z0-9_])re_[A-Za-z0-9_]{20,60}(?![A-Za-z0-9_])/dg,
    accept: (v) => hasDigit(v) && hasUpper(v) && hasLower(v),
  },
  {
    id: "npm-access-token",
    description: "npm access token (npm_)",
    re: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/dg,
  },
  {
    id: "discord-bot-token",
    description: "Discord bot token",
    re: /(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-])/dg,
    accept: (v) => hasDigit(v) && shannonEntropy(v) >= 3.5,
  },
  {
    id: "postgres-uri-password",
    description: "Password in a Postgres connection URI",
    re: /(?<![A-Za-z0-9+])postgres(?:ql)?:\/\/[^\s:@/]{0,256}:([^\s@/]{1,256})@/dg,
    group: 1,
    accept: (v) => !isUriPasswordPlaceholder(v),
  },
  {
    id: "mysql-uri-password",
    description: "Password in a MySQL/MariaDB connection URI",
    re: /(?<![A-Za-z0-9+])(?:mysql|mariadb)(?:\+[a-z0-9]{1,20})?:\/\/[^\s:@/]{0,256}:([^\s@/]{1,256})@/dg,
    group: 1,
    accept: (v) => !isUriPasswordPlaceholder(v),
  },
  {
    id: "mongodb-uri-password",
    description: "Password in a MongoDB connection URI",
    re: /(?<![A-Za-z0-9+])mongodb(?:\+srv)?:\/\/[^\s:@/]{0,256}:([^\s@/]{1,256})@/dg,
    group: 1,
    accept: (v) => !isUriPasswordPlaceholder(v),
  },
  {
    id: "redis-uri-password",
    description: "Password in a Redis connection URI",
    re: /(?<![A-Za-z0-9+])rediss?:\/\/[^\s:@/]{0,256}:([^\s@/]{1,256})@/dg,
    group: 1,
    accept: (v) => !isUriPasswordPlaceholder(v),
  },
];

const GENERIC_ID = "generic-secret";

/** key [:=] value — key must not start mid-word; `:` followed by `//` (URLs) is not an assignment. */
const ASSIGNMENT_RE =
  /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]{0,80})["']?[ \t]{0,4}(?:=|:(?!\/\/))[ \t]{0,4}(?:"([^"\r\n]{1,500})"|'([^'\r\n]{1,500})'|`([^`\r\n]{1,500})`|([^\s"'`,;]{1,500}))/dg;

const SECRET_KEY_PARTS = [
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "privatekey",
  "accesskey",
  "clientsecret",
  "auth",
];

function isSecretKeyName(key: string): boolean {
  const norm = key.toLowerCase().replace(/[-_.]/g, "");
  if (/author|authority|oauthurl|authurl|authorize|tokenizer|tokens?(?:count|limit|usage|budget|max|min)|max(?:output)?tokens?/.test(norm))
    return false;
  // Keys that name metadata about a secret rather than the secret itself.
  if (/(?:path|file|filename|dir|url|uri|endpoint|header|type|name|mode|provider|enabled|length|ttl|expiry|expires|lifetime|method|scheme)$/.test(norm))
    return false;
  return SECRET_KEY_PARTS.some((p) => norm.includes(p));
}

function isLikelyGenericSecret(value: string): boolean {
  if (value.length < 8) return false;
  if (value.includes(MARKER)) return false;
  if (isPlaceholder(value)) return false;
  if (value.includes("://")) return false; // URLs: connection-URI rules handle embedded credentials
  if (/[()]/.test(value)) return false; // function calls / code
  if (/^(?:\.{1,2}\/|~\/|\/)/.test(value) || /\.(?:pem|key|json|p12|pfx|crt|txt|ya?ml|env)$/i.test(value)) return false; // file paths
  if (/\s/.test(value)) return false; // quoted prose
  // Pure lowercase words (e.g. `my-secret-password`, `required`, `string`)
  if (/^[a-z]+(?:[-_.][a-z]+)*$/.test(value)) return false;
  // Identifiers / type names without digits (e.g. `AccessTokenResponse`, `this.token`)
  if (/^[A-Za-z_][A-Za-z_.]*$/.test(value) && shannonEntropy(value) < 4.2) return false;
  if (/^\d+(?:\.\d+)?$/.test(value)) return false; // numbers
  return shannonEntropy(value) >= 3.0;
}

/** Public rule catalogue (id + description), in priority order. */
export const SECRET_RULES: readonly { id: string; description: string }[] = Object.freeze([
  ...PATTERN_RULES.map(({ id, description }) => Object.freeze({ id, description })),
  Object.freeze({
    id: GENERIC_ID,
    description:
      "Generic .env/YAML/JSON assignment whose key names a secret (SECRET, TOKEN, PASSWORD, API_KEY, ...) with a high-entropy value",
  }),
]);

interface Candidate {
  start: number;
  end: number;
  rule: string;
  tier: number;
  priority: number;
}

function collectCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  PATTERN_RULES.forEach((rule, priority) => {
    const re = new RegExp(rule.re.source, rule.re.flags);
    const g = rule.group ?? 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const span = m.indices?.[g];
      const value = m[g];
      if (!span || value === undefined) continue;
      if (value.includes(MARKER)) continue;
      if (rule.accept && !rule.accept(value)) continue;
      out.push({ start: span[0], end: span[1], rule: rule.id, tier: 0, priority });
    }
  });

  const re = new RegExp(ASSIGNMENT_RE.source, ASSIGNMENT_RE.flags);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const key = m[1] ?? "";
    const groupIdx = m[2] !== undefined ? 2 : m[3] !== undefined ? 3 : m[4] !== undefined ? 4 : 5;
    const span = m.indices?.[groupIdx];
    const value = m[groupIdx];
    if (span && value !== undefined && isSecretKeyName(key) && isLikelyGenericSecret(value)) {
      out.push({ start: span[0], end: span[1], rule: GENERIC_ID, tier: 1, priority: PATTERN_RULES.length });
      re.lastIndex = span[1];
    } else if (span) {
      // Not a secret assignment: rescan inside the value (e.g. `url=https://x?token=...`).
      re.lastIndex = Math.max(span[0], m.index + 1);
    }
  }
  return out;
}

function resolve(candidates: Candidate[]): Candidate[] {
  candidates.sort(
    (a, b) => a.tier - b.tier || a.start - b.start || a.priority - b.priority || b.end - b.start - (a.end - a.start),
  );
  const accepted: Candidate[] = [];
  for (const c of candidates) {
    if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue;
    accepted.push(c);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Scan text for secrets and return a redacted copy plus the hits (rule id + 1-based line). */
export function scanSecrets(text: string): ScanResult {
  if (!text) return { redacted: text ?? "", hits: [] };
  const matches = resolve(collectCandidates(text));
  if (matches.length === 0) return { redacted: text, hits: [] };

  const starts = lineStarts(text);
  const parts: string[] = [];
  const hits: SecretHit[] = [];
  let pos = 0;
  for (const m of matches) {
    parts.push(text.slice(pos, m.start), `${MARKER}${m.rule}]`);
    pos = m.end;
    hits.push({ rule: m.rule, line: lineOf(starts, m.start) });
  }
  parts.push(text.slice(pos));
  return { redacted: parts.join(""), hits };
}

/**
 * Content-level check for credential files (service-account JSON, OAuth client secrets,
 * raw PEM private keys) — used to reject a file outright rather than redact it.
 */
export function looksLikeCredentialFile(name: string, text: string): boolean {
  if (/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/.test(text)) return true;

  const trimmed = text.trimStart();
  const jsonish = /\.json$/i.test(name) || trimmed.startsWith("{");
  if (!jsonish) return false;

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj.type === "service_account" || obj.type === "authorized_user" || obj.type === "external_account") return true;
      if (typeof obj.private_key === "string" && obj.private_key.length > 0) return true;
      for (const k of ["installed", "web"]) {
        const inner = obj[k];
        if (inner && typeof inner === "object" && typeof (inner as Record<string, unknown>).client_secret === "string")
          return true;
      }
      if (typeof obj.refresh_token === "string" && typeof obj.client_secret === "string") return true;
    }
    return false;
  } catch {
    // Malformed / partial JSON: fall back to textual markers.
    return (
      /"type"\s{0,10}:\s{0,10}"service_account"/.test(text) || /"private_key"\s{0,10}:\s{0,10}"[^"\r\n]{20,}/.test(text)
    );
  }
}
