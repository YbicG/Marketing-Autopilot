import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findJargon } from "@mkt/contracts";

// §2.6: no marketing jargon in anything a person reads. Scans JSX text and user-facing props, never
// code identifiers. A line (or the JSX line above) marked `jargon-ok` is allowed.
const ROOT = join(import.meta.dirname);
const PROPS = new Set(["title", "label", "placeholder", "aria-label", "description", "alt"]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx") ? [p] : [];
  });
}

interface Hit {
  file: string;
  line: number;
  term: string;
  text: string;
}

export function scanSource(file: string, source: string): Hit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split("\n");
  const allowed = (line: number) => /jargon-ok/.test(lines[line] ?? "") || /jargon-ok/.test(lines[line - 1] ?? "");
  const hits: Hit[] = [];
  const check = (node: ts.Node, text: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if (allowed(line)) return;
    for (const h of findJargon(text, "ui")) hits.push({ file, line: line + 1, term: h.term, text: text.trim().slice(0, 80) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) check(node, node.text);
    else if (ts.isJsxAttribute(node) && PROPS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) check(init, init.text);
      else if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) {
        check(init.expression, init.expression.text);
      }
    } else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression) && ts.isJsxElement(node.parent)) {
      check(node.expression, node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("UI copy has no marketing jargon (§2.6)", () => {
  it("flags JSX text and user-facing props, not identifiers", () => {
    const src = `const hookIdx = 1;\nexport const A = () => <div title="Your hooks">Write a CTA <Hook label="Opening line" /></div>;`;
    expect(scanSource("x.tsx", src).map((h) => h.term).sort()).toEqual(["CTA", "hooks"]);
  });

  it("honours jargon-ok", () => {
    expect(scanSource("x.tsx", `export const A = () => <p>SEO terms</p>; // jargon-ok`)).toEqual([]);
  });

  it("apps/web/src is clean", () => {
    const hits = tsxFiles(ROOT).flatMap((f) => scanSource(relative(ROOT, f), readFileSync(f, "utf8")));
    expect(hits.map((h) => `${h.file}:${h.line} "${h.term}" in "${h.text}"`)).toEqual([]);
  });
});
