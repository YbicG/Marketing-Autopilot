// Shared by the Agent access page (server) and its forms (client); kept out of the "use client" file.

export type Scope = "read" | "draft" | "generate";

export const SCOPE_LABELS: Record<Scope, { label: string; detail: string }> = {
  read: { label: "Look", detail: "See your projects, profile, calendar, results and spending." },
  draft: { label: "Write drafts", detail: "Save posts as drafts, put them on the calendar waiting for you, and suggest profile changes. You approve everything." },
  generate: { label: "Spend", detail: "Start campaigns. Up to $0.50 a go and $10 a month without asking; more needs you to confirm in the app." },
};

/** The claude mcp add line for this server, with the token in it (or a placeholder). */
export function setupLine(baseUrl: string, token: string) {
  return `claude mcp add --transport http mkt ${baseUrl}/api/mcp --header "Authorization: Bearer ${token}"`;
}
