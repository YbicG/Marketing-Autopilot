// Lint is for boundaries (§3.1), not style: the TS parser, a few cheap correctness rules,
// and no-restricted-imports per package. Later blocks replace the rule for their files.
import tseslint from "typescript-eslint";

const RULE = "@typescript-eslint/no-restricted-imports";

const SDK = {
  name: "@anthropic-ai/sdk",
  message: "Only packages/core/src/ai/** talks to the Anthropic SDK (§3.1). Go through @mkt/core/ai.",
};
const SDK_TYPES_ONLY = { ...SDK, allowTypeImports: true, message: `${SDK.message} Type-only imports are fine in core.` };
const RENDERER = [
  { name: "@remotion/renderer", message: "Rendering runs in the worker only, via @mkt/video/render (§3.1)." },
  { name: "@remotion/bundler", message: "Rendering runs in the worker only, via @mkt/video/render (§3.1)." },
];

const restrict = (paths, patterns = []) => ({ [RULE]: ["error", { paths, patterns }] });

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/.remotion/**",
      "**/migrations/**",
      "**/next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    languageOptions: { parser: tseslint.parser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-debugger": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-self-assign": "error",
      "no-unsafe-finally": "error",
      "no-unreachable": "error",
      "no-constant-binary-expression": "error",
      ...restrict([SDK]),
    },
  },
  // Core may name SDK types anywhere; only the ai module creates clients and calls it.
  { files: ["packages/core/src/**"], rules: restrict([SDK_TYPES_ONLY]) },
  { files: ["packages/core/src/ai/**"], rules: { [RULE]: "off" } },
  // The web image has no renderer, browser automation or Anthropic key (§3.1).
  {
    files: ["apps/web/**"],
    rules: restrict([
      SDK,
      ...RENDERER,
      { name: "playwright", message: "Browser automation runs in the worker only (§3.1)." },
      { name: "@mkt/video/render", message: "Rendering runs in the worker only (§3.1). Use @mkt/video for compositions." },
    ]),
  },
  // @mkt/video's main entry is browser-safe; only src/render may pull in the renderer.
  { files: ["packages/video/src/**"], ignores: ["packages/video/src/render/**"], rules: restrict([SDK, ...RENDERER]) },
  // db is the bottom layer.
  {
    files: ["packages/db/**"],
    rules: restrict(
      [SDK, { name: "@mkt/core", message: "@mkt/db must not depend on @mkt/core (§3.1)." }],
      [{ group: ["@mkt/core/*"], message: "@mkt/db must not depend on @mkt/core (§3.1)." }],
    ),
  },
  // contracts is shared by every app: zod and its own files only (tests may also use vitest).
  {
    files: ["packages/contracts/**"],
    ignores: ["**/*.test.ts"],
    rules: restrict([], [{ regex: "^(?!zod$|\\.{1,2}/)", message: "@mkt/contracts may import only zod and its own files (§3.1)." }]),
  },
);
