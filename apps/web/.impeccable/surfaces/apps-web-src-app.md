---
version: 1
slug: "apps-web-src-app"
primary_target: "src/app"
related_targets: ["src/components"]
---

# Surface brief: Marketing Autopilot web app (all signed-in pages)

Scope: every page under apps/web/src/app. Mode: Operate. Build path: code-led (no image generation).
Audience: CJ alone, a quick daily check (~10 min). First thing on screen: what needs you.

## Direction (incumbent, binding: D29 Studio, dark)

The shipped Studio UI is the design authority. Refinements preserve it.

- One sidebar layout listing every project; inside a project the sidebar swaps to that project's sections with "All projects" above. On phones the sidebar folds into a top menu.
- Dark: warm charcoal ground (`ground`, `rail`, `surface`, `raised`, `line`, `edge`), paper-cream ink (`ink`, `muted`, `faint`).
- Type: Geist sans for UI; Instrument Serif for display headings and the wordmark only.
- One primary colour, pine green (`accent*`). Colour meanings are fixed: green go/done, amber needs you (`warn`), clay didn't work (`danger`), dusty blue working (`info`).
- Touch targets: `min-h-11` on phones, `md:min-h-9` (or 8) on desktop.
- Motion: state changes only; reduced motion keeps the colour and drops pulses.

Cancelled (2026-09-28, by CJ): the "Ticket Rail" redesign (steel grey, Archivo, tickets on a rail). Do not reintroduce it.
