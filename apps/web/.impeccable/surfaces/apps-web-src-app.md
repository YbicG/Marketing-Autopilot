---
version: 1
slug: "apps-web-src-app"
primary_target: "apps/web/src/app"
related_targets: ["apps/web/src/components"]
---

# Surface brief: Marketing Autopilot web app (all signed-in pages)

Scope: every page under apps/web/src/app. Mode: Operate. Build path: code-led (no image generation).
Audience: CJ alone, a quick daily check (~10 min). First thing on screen: what needs you.
Pinned by the user: Studio sidebar layout listing every project; dark; colour meanings fixed (green go/done, amber needs you, clay didn't work, blue working). Asked for: less generic than serif-on-warm-dark; new type; stronger, product-specific details.
Input also: critique A (P1: one component vocabulary on every page; one primary colour; sidebar keeps the portfolio inside a project; previewed bulk approve, confirmed cancel, dialog drawer; loading/error/not-found states).

## Direction contract

THESIS: Every post is a ticket on a rail, in time order; CJ works the rail left to right and nothing leaves without an OK. Refuses the category default of a card grid plus a calendar with a blue accent, and the AI default of serif display on warm cream-dark.

OWN-WORLD: Cool steel-grey ground (not warm brown), paper-white ink. Tickets are raised stubs with a perforated top edge, a big condensed tabular time, platform, title, one action. One 1px steel rail line the tickets hang from, with a "now" marker. One family, Archivo, whose width axis gives condensed times, counts and prices; no serif anywhere. Pine green is the only primary colour; amber only for needs you; hatch marks missed and overdue; states are marks: hairline at rest, filled pressed, ring on focus, struck through when spent.

STORY: CJ opens the app and sees how many tickets need them, clears them on the rail, sees the next posts hanging in time order, and leaves knowing the server is posting.

FIRST VIEWPORT: Sidebar left (workspace: Home, Needs you with count, Spending; every project with status mark; switcher inside a project). Page: h1 "Needs you · 3" sized 28px with one summary line; directly beneath, one horizontal rail of amber tickets oldest first, each with its fix action; then "Going out" rail of the next posts with now marked; projects below. Primary action is the first ticket's button.

FORM: Ticket Rail, position 5 of my grounded list (re-roll round 1). Seed key 5ff52bad. Signature interaction: a ticket opens its detail in place on the rail (no modal), 200ms exponential ease-out; reduced motion swaps instantly. Motion grammar: state changes only, 150-250ms.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
