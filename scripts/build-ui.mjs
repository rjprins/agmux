import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const entry = path.resolve("src/ui/app.ts");
const out = path.resolve("public/app.js");
const outXtermCss = path.resolve("public/xterm.css");

await build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: true,
  target: ["es2020"],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
});

// xterm ships its own CSS; keep it in /public so our minimal static server can serve it.
await fs.copyFile(path.resolve("node_modules/@xterm/xterm/css/xterm.css"), outXtermCss);

// eslint-disable-next-line no-console
console.log(`Built ${path.relative(process.cwd(), out)}`);
