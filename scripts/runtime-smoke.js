import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Bridge } from "../plugins/signal/lib/bridge.js";
import { acquireSessionLock } from "../plugins/signal/lib/session-lock.js";
import { randomUUID } from "node:crypto";
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
const lockId = randomUUID();
const lockHandle = await acquireSessionLock({ dataDir: dir }, lockId);
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
  () => {},
  lockHandle.fd,
);
try {
  assert.deepEqual(await bridge.call("listAccounts"), []);
  await lockHandle.close();
  await assert.rejects(
    async () => {
      const unexpected = await acquireSessionLock({ dataDir: dir }, lockId);
      await unexpected.close();
    },
    { code: "session_in_use" },
  );
  console.log(
    "PASS: real Signal JSON-RPC starts offline, holds its session lock independently and releases it on exit",
  );
} finally {
  await bridge.close();
  await lockHandle.close();
  const recovered = await acquireSessionLock({ dataDir: dir }, lockId);
  await recovered.close();
  await fs.rm(dir, { recursive: true, force: true });
}
