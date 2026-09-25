import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { schema } from "@mkt/db";
import { secret } from "@mkt/core/config";
import { ensureWorkspaceForUser, githubLoginForUser, isAllowedLogin, parseAllowlist } from "@mkt/core/tenancy";
import { getDb } from "./db";

function createAuth() {
  const db = getDb();
  const allow = parseAllowlist(process.env.ALLOWED_GITHUB_LOGINS);
  const baseURL = secret("BETTER_AUTH_URL");

  return betterAuth({
    baseURL,
    secret: secret("BETTER_AUTH_SECRET"), // throws if missing: there is no fallback secret
    trustedOrigins: [baseURL],
    database: drizzleAdapter(db, {
      provider: "pg",
      usePlural: true,
      schema: { users: schema.users, sessions: schema.sessions, accounts: schema.accounts, verifications: schema.verifications },
    }),
    user: {
      additionalFields: { githubLogin: { type: "string", required: false, input: false } },
    },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      github: {
        clientId: secret("GITHUB_CLIENT_ID"),
        clientSecret: secret("GITHUB_CLIENT_SECRET"),
        scope: ["read:user", "user:email"],
        mapProfileToUser: (profile) => ({ githubLogin: profile.login }),
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => (isAllowedLogin(user.githubLogin, allow) ? undefined : false),
          after: async (user) => {
            await ensureWorkspaceForUser(db, user);
          },
        },
      },
      session: {
        create: {
          // Re-checked on every login, so removing someone from the allowlist locks them out.
          before: async (session) =>
            isAllowedLogin(await githubLoginForUser(db, session.userId), allow) ? undefined : false,
        },
      },
    },
    telemetry: { enabled: false },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
let auth: Auth | undefined;

/** Lazy for the same reason as getDb(): the build step has no secrets. */
export function getAuth(): Auth {
  auth ??= createAuth();
  return auth;
}
