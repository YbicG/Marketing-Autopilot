/**
 * DOM → markdown walker. Runs inside the page via runInPage(), so it must stay self-contained:
 * no imports and no references to anything outside this function body.
 *
 * Reads the live DOM without mutating it (screenshots are taken from the same page afterwards).
 */
export function domToMarkdown(maxChars: number): string {
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "CANVAS", "VIDEO", "AUDIO", "OBJECT",
    "EMBED", "NAV", "FOOTER", "INPUT", "TEXTAREA", "SELECT", "OPTION", "DIALOG", "IMG", "PICTURE",
  ]);
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET",
    "FIGCAPTION", "FIGURE", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
    "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "UL",
  ]);
  const INLINE_TAGS = new Set([
    "A", "ABBR", "B", "BUTTON", "CODE", "DEL", "EM", "I", "KBD", "LABEL", "MARK", "S", "SMALL", "SPAN",
    "STRONG", "SUB", "SUP", "TIME", "U", "BR",
  ]);
  // Consent banners and chat widgets are page chrome, not product copy.
  const CHROME_RE =
    /cookie|consent|gdpr|onetrust|didomi|usercentrics|cookiebot|intercom|crisp|drift|hubspot-messages|tawk|zendesk|chat-widget/i;
  const MAX_NODES = 40_000;

  const blocks: string[] = [];
  let total = 0;
  let visited = 0;

  const styleOf = (el: Element) => getComputedStyle(el);

  const skip = (el: Element): boolean => {
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return true;
    const role = el.getAttribute("role");
    if (role === "navigation" || role === "contentinfo" || role === "dialog" || role === "alertdialog") return true;
    // A page-level <header> is usually logo + nav; keep it only when it carries the hero headline.
    if ((tag === "HEADER" || role === "banner") && !el.closest("main,article") && !el.querySelector("h1")) return true;
    // Forms are stripped, except the rare pricing table that lives inside one.
    if (tag === "FORM" && !el.querySelector("table,[class*=pric],[id*=pric]")) return true;
    const idClass = `${el.id} ${el.getAttribute("class") ?? ""}`;
    if (CHROME_RE.test(idClass)) return true;
    const cs = styleOf(el);
    return cs.display === "none" || cs.visibility === "hidden";
  };

  const isBlock = (el: Element): boolean => {
    const tag = el.tagName.toUpperCase();
    if (BLOCK_TAGS.has(tag)) return true;
    if (INLINE_TAGS.has(tag)) return false;
    const d = styleOf(el).display;
    return !d.startsWith("inline") && d !== "contents";
  };

  const clean = (s: string) => s.replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim();

  const push = (raw: string) => {
    const s = raw.replace(/\n{3,}/g, "\n\n").trim();
    if (!s || blocks[blocks.length - 1] === s) return;
    blocks.push(s);
    total += s.length + 2;
  };

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    if (++visited > MAX_NODES || skip(el)) return "";
    const tag = el.tagName.toUpperCase();
    if (tag === "BR") return "\n";
    let content = "";
    for (const child of Array.from(el.childNodes)) content += inline(child);
    const t = content.replace(/\s+/g, " ").trim();
    if (!t) return content.includes("\n") ? "\n" : "";
    if (tag === "A") {
      const href = (el as HTMLAnchorElement).href;
      // Card-sized links are layout, not links: keep the text only.
      if (/^https?:/i.test(href) && t.length <= 200) return ` [${t.replace(/[[\]]/g, "")}](${href}) `;
      return ` ${t} `;
    }
    if (tag === "STRONG" || tag === "B") return ` **${t}** `;
    if (tag === "EM" || tag === "I") return ` _${t}_ `;
    if (tag === "CODE" || tag === "KBD") return `\`${t}\``;
    return isBlock(el) ? `\n${content}\n` : content;
  };

  const inlineOf = (el: Element) => {
    let s = "";
    for (const child of Array.from(el.childNodes)) s += inline(child);
    return clean(s);
  };

  const list = (el: Element, depth: number): string[] => {
    const lines: string[] = [];
    const ordered = el.tagName.toUpperCase() === "OL";
    let n = 0;
    for (const li of Array.from(el.children)) {
      if (li.tagName.toUpperCase() !== "LI" || skip(li)) continue;
      n++;
      let text = "";
      const nested: string[] = [];
      for (const child of Array.from(li.childNodes)) {
        const ct = child.nodeType === Node.ELEMENT_NODE ? (child as Element).tagName.toUpperCase() : "";
        if (ct === "UL" || ct === "OL") nested.push(...list(child as Element, depth + 1));
        else text += inline(child);
      }
      const body = clean(text).replace(/\n+/g, " ");
      if (body) lines.push(`${"  ".repeat(depth)}${ordered ? `${n}.` : "-"} ${body}`);
      lines.push(...nested);
    }
    return lines;
  };

  const table = (el: Element) => {
    const rows: string[][] = [];
    for (const tr of Array.from(el.querySelectorAll("tr")).slice(0, 150)) {
      if (tr.closest("table") !== el) continue; // nested tables are read on their own
      const cells = Array.from(tr.children)
        .filter((c) => c.tagName === "TD" || c.tagName === "TH")
        .map((c) => inlineOf(c).replace(/\n+/g, " ").replace(/\|/g, "\\|"));
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length === 0) return;
    const cols = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
    const out = [line(rows[0]!), `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`];
    for (const r of rows.slice(1)) out.push(line(r));
    push(out.join("\n"));
  };

  const block = (el: Element) => {
    if (total > maxChars || ++visited > MAX_NODES || skip(el)) return;
    const tag = el.tagName.toUpperCase();
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) {
      const t = inlineOf(el).replace(/\n+/g, " ");
      if (t) push(`${"#".repeat(Number(heading[1]))} ${t}`);
      return;
    }
    if (tag === "P" || tag === "DT" || tag === "DD" || tag === "FIGCAPTION" || tag === "SUMMARY") {
      push(inlineOf(el));
      return;
    }
    if (tag === "UL" || tag === "OL") {
      push(list(el, 0).join("\n"));
      return;
    }
    if (tag === "TABLE") {
      table(el);
      return;
    }
    if (tag === "PRE") {
      const code = (el as HTMLElement).innerText.trim();
      if (code) push("```\n" + code.slice(0, 4000) + "\n```");
      return;
    }
    if (tag === "BLOCKQUOTE") {
      const q = inlineOf(el);
      if (q) push(q.split("\n").map((l) => `> ${l}`).join("\n"));
      return;
    }
    if (tag === "HR") return;

    // Generic container: runs of inline content become paragraphs, block children recurse.
    let buf = "";
    const flush = () => {
      push(clean(buf));
      buf = "";
    };
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const c = child as Element;
        if (isBlock(c)) {
          flush();
          block(c);
          continue;
        }
      }
      buf += inline(child);
    }
    flush();
  };

  if (document.body) block(document.body);
  let md = blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  if (md.length > maxChars) md = md.slice(0, maxChars).trimEnd() + "\n\n…";
  return md;
}
