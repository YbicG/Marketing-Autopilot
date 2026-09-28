import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLS, toolListing } from "./mcp.ts";
import { defineTool, EFFECT_SCOPE, FORBIDDEN_TOOL_VERBS, toolRegistry } from "./registry.ts";

const base = { description: "d", input: z.object({}), output: z.unknown(), run: async () => null };

describe("defineTool", () => {
  it("refuses names that would approve, publish, verify or accept (D9)", () => {
    for (const name of ["approve_posts", "publish_now", "verify_claim", "accept_dna_change", "activate_automation", "confirm_spend"]) {
      expect(() => defineTool({ ...base, name, effect: "draft", scopes: ["draft"] })).toThrow(/can't approve/);
    }
    expect(() => defineTool({ ...base, name: "Bad-Name", effect: "read", scopes: ["read"] })).toThrow(/Bad tool name/);
  });

  it("needs the scope its effect implies, and spend tools need an estimate", () => {
    expect(() => defineTool({ ...base, name: "draft_thing", effect: "draft", scopes: ["read"] })).toThrow(/needs the draft scope/);
    expect(() => defineTool({ ...base, name: "spend_thing", effect: "spend", scopes: ["generate"] })).toThrow(/needs an estimate/);
    expect(defineTool({ ...base, name: "spend_thing", effect: "spend", scopes: ["generate"], estimate: async () => 1 }).name).toBe("spend_thing");
  });

  it("a registry has one tool per name", () => {
    const t = defineTool({ ...base, name: "list_things", effect: "read", scopes: ["read"] });
    expect(() => toolRegistry([t, t])).toThrow(/Duplicate/);
  });
});

describe("the tool catalog", () => {
  it("has the M5 tools and no approve, publish, verify or accept tool", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "create_post_variants",
        "estimate_package",
        "get_calendar",
        "get_job",
        "get_launch_tasks",
        "get_product_dna",
        "get_results",
        "get_spend",
        "list_content",
        "list_products",
        "propose_dna_change",
        "run_package",
        "schedule_posts",
      ].sort(),
    );
    for (const t of TOOLS) {
      expect(FORBIDDEN_TOOL_VERBS.test(t.name)).toBe(false);
      expect(t.scopes).toContain(EFFECT_SCOPE[t.effect]);
    }
    expect(TOOLS.filter((t) => t.effect === "spend").map((t) => t.name)).toEqual(["run_package"]);
  });

  it("lists a JSON schema per tool; spend tools take the confirm code", () => {
    const list = toolListing();
    const run = list.find((t) => t.name === "run_package")!;
    expect(run.inputSchema.type).toBe("object");
    expect(Object.keys(run.inputSchema.properties as object)).toEqual(expect.arrayContaining(["product", "tier", "confirmToken"]));
    expect(Object.keys(list.find((t) => t.name === "create_post_variants")!.inputSchema.properties as object)).not.toContain("confirmToken");
  });
});
