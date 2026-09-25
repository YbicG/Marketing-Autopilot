import type { Db } from "@mkt/db";
import {
  pullConversions,
  pullPostMetrics,
  type ConversionRow,
  type FirstPartyClient,
  type ConversionDeps,
} from "@mkt/core/analytics";
import type { MaintJobs } from "@mkt/core/queue";
import type { ProviderCtx } from "@mkt/providers";

export interface AnalyticsWorkerDeps {
  db: Db;
  ctxFor: (workspaceId: string) => ProviderCtx;
  clientFor: ConversionDeps["clientFor"];
}

export function maintAnalyticsPull(deps: AnalyticsWorkerDeps, data: MaintJobs["maint.analytics_pull"]) {
  return pullPostMetrics({ db: deps.db, ctxFor: deps.ctxFor }, data);
}

export function maintConversionsPull(deps: AnalyticsWorkerDeps, _data: MaintJobs["maint.conversions_pull"]) {
  return pullConversions({ db: deps.db, clientFor: deps.clientFor });
}

/**
 * First-party aggregate endpoint (SyllaCal UTM PR 1, §5.9): token-protected, no personal data.
 * ASSUMPTION until that PR lands: GET {baseUrl}/api/marketing/utm-aggregate?from=YYYY-MM-DD&to=YYYY-MM-DD
 * with `Authorization: Bearer <token>` returning { rows: ConversionRow[] }.
 */
export function httpFirstPartyClient(opts: {
  baseUrl: string;
  token: string;
  fetchText: (url: string, init: { headers: Record<string, string> }) => Promise<string>;
}): FirstPartyClient {
  return {
    async daily({ from, to }) {
      const url = new URL("/api/marketing/utm-aggregate", opts.baseUrl);
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);
      const body = JSON.parse(await opts.fetchText(url.toString(), { headers: { authorization: `Bearer ${opts.token}` } })) as {
        rows?: ConversionRow[];
      };
      return Array.isArray(body.rows) ? body.rows : [];
    },
  };
}

export async function runAnalyticsJob(deps: AnalyticsWorkerDeps, name: string, data: unknown): Promise<unknown> {
  switch (name) {
    case "maint.analytics_pull":
      return maintAnalyticsPull(deps, data as MaintJobs["maint.analytics_pull"]);
    case "maint.conversions_pull":
      return maintConversionsPull(deps, {});
    default:
      throw new Error(`not an analytics job: ${name}`);
  }
}
