import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ensureRuntime, platformKey } from "../plugins/signal/lib/runtime.js";
async function bundle(t, symlink = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-install-")),
    tree = path.join(dir, "tree");
  const bin = path.join(tree, "runtime/jre/bin");
  await fs.mkdir(bin, { recursive: true });
  if (symlink) await fs.symlink("/bin/sh", path.join(bin, "java"));
  else
    await fs.writeFile(path.join(bin, "java"), "#!/bin/sh\nexit 99\n", {
      mode: 0o755,
    });
  const archive = path.join(dir, "bundle.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", tree, "runtime"]);
  const bytes = await fs.readFile(archive),
    key = platformKey(),
    name = "signal-runtime-" + key + ".tar.gz";
  const ctx = {
    manifest: { version: "1.2.3" },
    settings: {},
    dataDir: path.join(dir, "data"),
  };
  const original = globalThis.fetch;
  let calls = 0,
    wrong = false;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).endsWith("sha256sums.txt"))
      return new Response(
        (wrong
          ? "f".repeat(64)
          : createHash("sha256").update(bytes).digest("hex")) +
          "  " +
          name +
          "\n",
      );
    return new Response(bytes);
  };
  t.after(async () => {
    globalThis.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    ctx,
    dir,
    key,
    calls: () => calls,
    wrong: () => {
      wrong = true;
    },
  };
}
test("managed installer verifies/extracts once and shares concurrent downloads", async (t) => {
  const f = await bundle(t);
  const [a, b] = await Promise.all([
    ensureRuntime(f.ctx),
    ensureRuntime(f.ctx),
  ]);
  assert.equal(a.executable, b.executable);
  assert.equal(f.calls(), 2);
  assert.match(await fs.readFile(a.executable, "utf8"), /exit 99/);
  await ensureRuntime(f.ctx);
  assert.equal(f.calls(), 2);
  assert.equal(
    await fs.readFile(
      path.join(f.ctx.dataDir, "runtimes/1.2.3", f.key, ".verified"),
      "utf8",
    ),
    "1.2.3\n",
  );
});
test("checksum mismatch leaves no executable runtime", async (t) => {
  const f = await bundle(t);
  f.wrong();
  await assert.rejects(() => ensureRuntime(f.ctx), /checksum/);
  await assert.rejects(() =>
    fs.access(path.join(f.ctx.dataDir, "runtimes/1.2.3", f.key, ".verified")),
  );
});
test("runtime archive links are rejected before extraction", async (t) => {
  const f = await bundle(t, true);
  await assert.rejects(() => ensureRuntime(f.ctx), /invalid_runtime_archive/);
  await assert.rejects(() =>
    fs.access(path.join(f.ctx.dataDir, "runtimes/1.2.3", f.key, "runtime")),
  );
});
