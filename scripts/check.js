import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = "plugins/signal";
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) =>
      d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)],
    );
}
for (const f of [...walk(root), ...walk("scripts"), ...walk("test")]) {
  if (f.endsWith(".js") || f.endsWith(".cjs"))
    execFileSync(process.execPath, ["--check", f]);
  if (f.startsWith(root) && /\.[jt]s$/.test(f))
    assert(
      !/from\s+["'](?:\.\.\/){3}|node_modules/.test(fs.readFileSync(f, "utf8")),
      f + " must remain self-contained",
    );
}
const pkg = JSON.parse(fs.readFileSync("package.json")),
  manifest = JSON.parse(fs.readFileSync(root + "/plugin.json"));
assert.equal(pkg.version, manifest.version);
assert.equal(
  JSON.parse(fs.readFileSync("package-lock.json")).packages[""].version,
  pkg.version,
);
console.log(
  "Signal plugin syntax, self-contained imports and versions verified.",
);
