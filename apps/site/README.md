# apps/site

Public legal site (§8, M2): `/`, `/terms`, `/privacy`, `/data-deletion`, `/contact`. Plain HTML and one stylesheet: no build step, no dependencies. Replace the `[Company name]`, `[domain]`, `[contact email]`, `[postal address]`, `[jurisdiction]` and `[date]` placeholders before publishing.

Deploy: Cloudflare Pages → Create project → connect the repo (or Direct upload), **build command empty**, **output directory `apps/site`**. Pages serves `terms.html` at `/terms`. Add the custom domain (`[domain]` or `www.[domain]`) in the Pages project.
