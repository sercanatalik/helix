// Renders src-tauri/icons/icon.svg into icon.png at 1024×1024 with a
// transparent background. Run with `pnpm build:icon`.
//
// `tauri::generate_context!()` reads icon.png at compile time and embeds it
// in the binary, so after running this you also need to bump the Rust source
// (e.g. `touch src-tauri/src/lib.rs`) to force a rebuild.

import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const svgPath = resolve(repoRoot, "src-tauri/icons/icon.svg");
const pngPath = resolve(repoRoot, "src-tauri/icons/icon.png");

const svg = readFileSync(svgPath);
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1024 },
  background: "rgba(0,0,0,0)",
});
const png = resvg.render().asPng();
writeFileSync(pngPath, png);

console.log(`wrote ${pngPath} (${png.byteLength} bytes)`);
