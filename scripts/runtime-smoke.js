import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Bridge } from "../plugins/signal/lib/bridge.js";
const root = path.resolve(
  process.env.SIGNAL_RUNTIME_ROOT ?? ".local/runtime/runtime",
);
const java = path.join(root, "jre/bin/java"),
  lib = path.join(root, "signal-cli/lib/*");
const probe = path.resolve(process.env.SIGNAL_PROBE_DIR ?? ".local/probe");
if (!process.env.SIGNAL_PROBE_DIR) {
  await fs.mkdir(probe, { recursive: true });
  execFileSync(
    "javac",
    ["--release", "17", "-d", probe, "scripts/RuntimeSmoke.java"],
    { stdio: "inherit" },
  );
}
execFileSync(
  java,
  [
    "--enable-native-access=ALL-UNNAMED",
    "-cp",
    probe + ":" + lib,
    "RuntimeSmoke",
  ],
  { stdio: "inherit" },
);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-runtime-smoke-"));
const bridge = new Bridge(
  {
    executable: java,
    prefix: [
      "--enable-native-access=ALL-UNNAMED",
      "-cp",
      lib,
      "org.asamk.signal.Main",
    ],
  },
  dir,
);
try {
  assert.deepEqual(await bridge.call("listAccounts"), []);
  console.log(
    "PASS: real Signal JSON-RPC process starts offline with an empty private store",
  );
} finally {
  await bridge.close();
  await fs.rm(dir, { recursive: true, force: true });
}
