// §8 "SEO pages": not built in this wave. The generator, its checks and the PR-based publish
// path arrive in M5; these rows stay open until then.
import { describe, it } from "vitest";

describe("§8 SEO pages", () => {
  it.todo("at most 2 SEO pages a week per product — M5 (SEO generator not built)");
  it.todo("every page cites facts from the profile; no made-up numbers — M5");
  it.todo("pages go out as a pull request the person merges, never a direct push — M5 (fine-grained PAT scopes)");
  it.todo("no near-duplicate pages (thin-content rule) — M5");
});
