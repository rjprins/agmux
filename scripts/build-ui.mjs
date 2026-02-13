import { build } from "esbuild";
import path from "node:path";
import process from "node:process";

const entry = path.resolve("src/ui/app.ts");
const out = path.resolve("public/app.js");

await build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: "browser",
  format: "iife",
  sourcemap: true,
  target: ["es2020"],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
});

// eslint-disable-next-line no-console
console.log(`Built ${path.relative(process.cwd(), out)}`);

