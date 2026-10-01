// Bundles the CLI and the engine into one file: cli/dist/yamlet.js.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

await build({
  entryPoints: [join(here, "src/bin.ts")],
  outfile: join(here, "dist/yamlet.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Runtime dependencies are installed with the package rather than inlined.
  external: Object.keys(pkg.dependencies ?? {}),
  banner: { js: "#!/usr/bin/env node" },
  define: { __YAMLET_VERSION__: JSON.stringify(process.env.YAMLET_VERSION ?? pkg.version) },
  legalComments: "none",
});
