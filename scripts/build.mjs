import { chmodSync } from "node:fs";
import { build } from "esbuild";

// Bundle cli.ts with every runtime dep inlined. The published package ships
// a self-contained dist/cli.js plus a package.json with "dependencies": {},
// so `npx ghreview` does zero dep resolution at install time — users get
// byte-for-byte the code that was built at publish time.
//
// ESM output with a createRequire shim so transitively-bundled CJS deps
// (postcss via sanitize-html) can still resolve `require("node:path")`
// and friends.
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/cli.js",
  legalComments: "none",
  minify: false,
  treeShaking: true,
  banner: {
    js:
      '#!/usr/bin/env node\n' +
      'import { createRequire as __ghrCreateRequire } from "node:module";\n' +
      "const require = __ghrCreateRequire(import.meta.url);",
  },
  external: [],
  logLevel: "info",
});

// npm pack preserves file mode from disk, so the bin must be executable
// here — otherwise `npx @tgwizard/ghreview` fails at exec time.
chmodSync("dist/cli.js", 0o755);
