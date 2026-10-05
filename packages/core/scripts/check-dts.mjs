// Post-build guard for the published type declarations.
//
// Fails the build if any dist/*.d.ts / *.d.mts file imports a module that a
// consumer can't resolve: a relative path with no matching declaration file in
// dist/, or a workspace-only @dstorage/* package (bundled here, never
// published). With skipLibCheck — the default in most consumer projects — such
// imports fail silently and every type behind them degrades to `any`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const SPECIFIER_RE =
  /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)(["'])([^"']+)\1/gm;

const declarationCandidates = (spec, fromFile) => {
  const base = join(dirname(fromFile), spec).replace(/\.(m?js|cjs)$/, "");
  return [".d.ts", ".d.mts", ".d.cts", "/index.d.ts"].map((ext) => base + ext);
};

const problems = [];
for (const name of readdirSync(distDir)) {
  if (!/\.d\.m?ts$/.test(name)) continue;
  const file = join(distDir, name);
  for (const [, , spec] of readFileSync(file, "utf8").matchAll(SPECIFIER_RE)) {
    if (spec.startsWith("@dstorage/")) {
      problems.push(`${name}: imports workspace-only package "${spec}"`);
    } else if (
      spec.startsWith(".") &&
      !declarationCandidates(spec, file).some((p) => existsSync(p))
    ) {
      problems.push(`${name}: imports "${spec}", which is not in dist/`);
    }
  }
}

if (problems.length > 0) {
  console.error(
    "[dStorage/build] Unresolvable imports in published type declarations:\n" +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
  process.exit(1);
}
console.log("[dStorage/build] Type declarations are self-contained.");
