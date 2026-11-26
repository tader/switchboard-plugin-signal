import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { platformKey } from "../plugins/signal/lib/runtime.js";
const root = process.env.SWITCHBOARD_ROOT;
if (!root)
  throw Error(
    "Set SWITCHBOARD_ROOT to a Switchboard checkout with QR support and installed dependencies.",
  );
const core = path.resolve(root),
  dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "switchboard-signal-integration-"),
  );
process.env.SWITCHBOARD_DATA_DIR = path.join(dir, "data");
process.env.SWITCHBOARD_WATCH_PLUGINS = "false";
process.env.SWITCHBOARD_PUBLIC_URL = "http://localhost:8770";
process.env.SWITCHBOARD_BUILTIN_PLUGINS_DIR = path.join(core, "plugins");
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_ROOT = path.join(dir, "outputs");
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE = "1";
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_INSTANCE = "signal-fixture";
process.env.SWITCHBOARD_ACTIVITY_PREVIEW_EPOCH = "signal-fixture";
fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR, { recursive: true });
const load = (file) => import(pathToFileURL(path.join(core, file)).href),
  realFetch = globalThis.fetch;
const archiveRoot = path.join(dir, "archive-root");
fs.mkdirSync(path.join(archiveRoot, "plugins"), { recursive: true });
fs.cpSync("plugins/signal", path.join(archiveRoot, "plugins/signal"), {
  recursive: true,
});
const tar = createRequire(path.join(core, "package.json"))("tar"),
  archive = path.join(dir, "signal.tgz");
await tar.c({ gzip: true, file: archive, cwd: dir }, ["archive-root"]);
const nextBytes = fs.readFileSync(archive),
  version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
// The previous installation uses an offline executable. Its settings can be
// cleared without downloading, so the real update triggers a cold managed runtime.
const oldManifest = path.join(archiveRoot, "plugins/signal/plugin.json");
const old = JSON.parse(fs.readFileSync(oldManifest, "utf8"));
old.version = "0.0.1";
old.main = "index.js";
fs.writeFileSync(oldManifest, JSON.stringify(old));
fs.writeFileSync(
  path.join(archiveRoot, "plugins/signal/index.js"),
  'import {createAdapter} from "./lib/adapter.js"; export default ctx=>createAdapter({...ctx,settings:{...ctx.settings,signalCliPath:' +
    JSON.stringify(path.resolve("test/fixture-helper.cjs")) +
    "}});",
);
await tar.c({ gzip: true, file: archive, cwd: dir }, ["archive-root"]);
const bytes = fs.readFileSync(archive),
  sha = "b".repeat(40),
  nextSha = "c".repeat(40);
let upgrading = false,
  releaseDownload,
  downloadStarted,
  downloadAborted = false;
const downloadGate = new Promise((resolve) => (releaseDownload = resolve)),
  downloadEntered = new Promise((resolve) => (downloadStarted = resolve));
const runtimeTree = path.join(dir, "runtime-tree"),
  runtimeBin = path.join(runtimeTree, "runtime/jre/bin");
fs.mkdirSync(runtimeBin, { recursive: true });
fs.writeFileSync(
  path.join(runtimeBin, "java"),
  "#!/usr/bin/env node\nrequire(" +
    JSON.stringify(path.resolve("test/fixture-helper.cjs")) +
    ");\n",
  { mode: 0o755 },
);
const runtimeArchive = path.join(dir, "runtime.tgz");
await tar.c({ gzip: true, file: runtimeArchive, cwd: runtimeTree }, [
  "runtime",
]);
const runtimeBytes = fs.readFileSync(runtimeArchive),
  runtimeName = "signal-runtime-" + platformKey() + ".tar.gz";
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  if (url.startsWith("https://api.github.com/repos/fixture/signal/")) {
    if (url.includes("/releases")) {
      const r = {
        tag_name: upgrading ? "v" + version : "v0.0.1",
        published_at: "2026-10-22T00:00:00Z",
      };
      return Response.json(url.endsWith("/latest") ? r : [r]);
    }
    if (url.includes("/commits/"))
      return new Response(upgrading ? nextSha : sha);
    if (url.includes("/tarball/"))
      return new Response(url.endsWith(nextSha) ? nextBytes : bytes);
  }
  if (
    url.startsWith(
      "https://github.com/tader/switchboard-plugin-signal/releases/download/",
    )
  ) {
    if (url.endsWith("sha256sums.txt")) {
      downloadStarted();
      await new Promise((resolve, reject) => {
        const abort = () => {
          downloadAborted = true;
          reject(opts.signal.reason);
        };
        opts.signal.addEventListener("abort", abort, { once: true });
        downloadGate.then(() => {
          opts.signal.removeEventListener("abort", abort);
          resolve();
        });
        if (opts.signal.aborted) abort();
      });
      return new Response(
        createHash("sha256").update(runtimeBytes).digest("hex") +
          "  " +
          runtimeName +
          "\n",
      );
    }
    return new Response(runtimeBytes);
  }
  if (url.startsWith("http://127.0.0.1:")) return realFetch(input, opts);
  throw Error("Unexpected network destination");
};
let manager, database;
try {
  const crypto = await load("server/crypto.ts");
  database = await load("server/db.ts");
  crypto.initKey();
  database.initDb();
  manager = (await load("server/plugins/manager.ts")).plugins;
  await manager.start();
  const user = (await load("server/users.ts")).createUser(
    "signal-integration",
    "admin",
  );
  await (
    await load("server/plugins/github.ts")
  ).install({ repo: "fixture/signal", path: "plugins/signal" }, { user });
  assert.equal(manager.get("signal").status, "active");
  await manager.saveSettings("signal", {
    signalCliPath: path.resolve("test/fixture-helper.cjs"),
  });
  const connections = await load("server/connections.ts");
  const flow = await connections.startConnect(user, {
    service: "signal",
    method: "linked-device",
    config: { access: "write" },
  });
  assert.equal(flow.status, "device");
  assert.match(flow.device.qrCode, /^sgnl:/);
  let connected;
  for (let i = 0; i < 100; i++) {
    connected = await connections.pollDevice(flow.flowId, user);
    if (connected.status === "connected") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(connected.status, "connected");
  const conn = connected.connection;
  await new Promise((r) => setTimeout(r, 30));
  const { execute } = await load("server/proxy.ts");
  const output = await load("server/activity-output.ts");
  const previewRoot = process.env.SWITCHBOARD_ACTIVITY_PREVIEW_ROOT;
  const { openPreviewStore } = await load("shared/activity-preview-store.ts");
  openPreviewStore(
    previewRoot,
    [process.env.SWITCHBOARD_DATA_DIR],
    "signal-fixture",
  );
  const { config } = await load("server/config.ts");
  config.previewStoreId = JSON.parse(
    fs.readFileSync(path.join(previewRoot, "store.json"), "utf8"),
  ).storeId;
  output.initOutputStore();
  assert.equal(output.outputCaptureAvailability().available, true);
  output.setOutputRetention(4);

  const installedFetch = globalThis.fetch;
  const audited = async (
    url,
    { method = "GET", headers, reply, requests = 1 } = {},
  ) => {
    let upstream;
    let count = 0;
    globalThis.fetch = async (input, opts) => {
      assert.equal(input.hostname, "127.0.0.1");
      count++;
      const response = reply
        ? reply(opts.headers, count)
        : await installedFetch(input, opts);
      if (count === requests) upstream = response.clone();
      return response;
    };
    try {
      const result = await execute(
        user,
        conn.id,
        { method, url, headers },
        undefined,
        { source: "proxy", tokenId: null, tokenName: null, ip: null, userAgent: null },
      );
      assert.ok(result.auditId);
      assert.equal(result.response.status, upstream.status);
      assert.deepEqual([...result.response.headers], [...upstream.headers]);
      const body = Buffer.from(await result.response.arrayBuffer());
      assert.deepEqual(body, Buffer.from(await upstream.arrayBuffer()));
      assert.equal(count, requests);
      return { body, ...output.readOutput(user.id, result.auditId, true) };
    } finally {
      globalThis.fetch = installedFetch;
    }
  };
  const projected = { historyCoverage: "synced_cache_only" };
  const capabilities = await audited("/capabilities");
  const capabilityBody = JSON.parse(capabilities.body);
  assert.equal(capabilityBody.access, "write");
  assert.equal(capabilityBody.features.send, true);
  assert.deepEqual(capabilities.preview, projected);
  for (const [url, method] of [
    ["/status", "GET"],
    ["/capabilities?access=read", "GET"],
    ["/capabilities", "HEAD"],
  ]) {
    assert.equal((await audited(url, { method })).state, "omitted");
  }
  const withPrivateFields = {
    ...projected,
    account: "private-fixture-account",
    nested: { token: "private-fixture-token" },
  };
  const retried = await audited("/capabilities", {
    requests: 2,
    reply: (_, count) => count === 1
      ? Response.json({ error: "retry" }, { status: 401 })
      : Response.json(withPrivateFields),
  });
  assert.deepEqual(retried.preview, projected);
  const credentialEcho = await audited("/capabilities", {
    headers: [["x-api-key", "fixture-secret"]],
    reply: (headers) => Response.json({ historyCoverage: headers.get("x-api-key") }),
  });
  assert.equal(credentialEcho.state, "omitted");
  for (const reply of [
    () => Response.json({ historyCoverage: "é".repeat(17) }),
    () => Response.json(withPrivateFields, { status: 503 }),
    () => new Response(null, { status: 204 }),
    () => new Response(JSON.stringify(withPrivateFields)),
    () => new Response("{", { headers: { "content-type": "application/json" } }),
  ]) {
    assert.equal((await audited("/capabilities", { reply })).state, "omitted");
  }
  assert.equal(database.one("SELECT count(*) AS count FROM audit_outputs").count, 2);
  output.setOutputRetention(0);
  assert.equal((await audited("/capabilities")).state, "disabled");
  assert.equal(database.one("SELECT count(*) AS count FROM audit_outputs").count, 0);
  output.setOutputRetention(4);
  config.previewRestoreSafe = false;
  output.initOutputStore();
  assert.equal((await audited("/capabilities")).state, "omitted");
  config.previewRestoreSafe = true;
  output.initOutputStore();

  const call = async (method, url, body) => {
    const r = await execute(user, conn.id, {
      method,
      url,
      headers: [["content-type", "application/json"]],
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.response.status, data: await r.response.json() };
  };
  assert.equal((await call("GET", "/status")).data.ready, true);
  const chat = (await call("GET", "/chats")).data.items.find(
    (c) => c.type === "direct",
  ).id;
  const input = {
    chat,
    text: "offline integration",
    idempotencyKey: "integration-send",
  };
  assert.equal((await call("POST", "/messages", input)).data.ok, true);
  assert.equal((await call("POST", "/messages", input)).data.replayed, true);
  const stored = database.one(
    "SELECT credentials_enc,config_enc FROM connections WHERE id=?",
    conn.id,
  );
  assert(!stored.credentials_enc.includes("11111111"));
  assert.deepEqual(crypto.decrypt(stored.config_enc), { access: "write" });
  const description = await (
    await load("server/openapi.ts")
  ).describe(
    manager.service("signal"),
    connections.loadConnection(user.id, conn.id).conn,
  );
  assert.equal(description.operations.length, 9);
  assert(description.operations.some((o) => o.id === "voteSignalPoll"));
  const ready = async () => {
    for (let i = 0; i < 300; i++) {
      const status = await call("GET", "/status");
      if (status.data.ready) return;
      assert.equal(status.status, 503);
      assert.equal(status.data.error.code, "helper_starting");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error("Saved Signal session did not restore");
  };
  await manager.saveSettings("signal", { signalCliPath: "" });
  await ready();
  const linked = crypto.decrypt(stored.credentials_enc),
    trace = path.join(
      process.env.SWITCHBOARD_DATA_DIR,
      "plugin-data/signal/profiles",
      linked.profile,
      "fixture-trace.jsonl",
    ),
    sends = () =>
      fs
        .readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse)
        .filter((r) => r.method === "send").length;
  assert.equal(sends(), 1);
  upgrading = true;
  let deadline;
  try {
    await Promise.race([
      (await load("server/plugins/github.ts")).update("signal", {}, { user }),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(Error("Cold download blocked real plugin activation")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  assert.equal(manager.get("signal").status, "active");
  assert.equal(manager.get("signal").manifest.version, version);
  await downloadEntered;
  const starting = await call("POST", "/messages", {
    ...input,
    idempotencyKey: "blocked-during-startup",
  });
  assert.equal(starting.status, 503);
  assert.equal(starting.data.error.code, "helper_starting");
  assert.equal(
    sends(),
    1,
    "An initializing session must not send a write later",
  );
  await manager.setEnabled("signal", false);
  assert.equal(downloadAborted, true);
  assert(
    !fs.existsSync(path.join(path.dirname(trace), "owner.json")),
    "Cancellation must release ownership",
  );
  releaseDownload();
  await manager.setEnabled("signal", true);
  await ready();
  assert.equal((await call("POST", "/messages", input)).data.replayed, true);
  assert.deepEqual((await audited("/capabilities")).preview, projected);
  assert.equal(sends(), 1);
  await manager.stop();
  await manager.start();
  await ready();
  assert.equal((await call("POST", "/messages", input)).data.replayed, true);
  assert.equal((await call("GET", "/status")).data.ready, true);
  await connections.deleteConnection(user.id, conn.id);
  assert.equal(
    fs.readdirSync(
      path.join(
        process.env.SWITCHBOARD_DATA_DIR,
        "plugin-data/signal/profiles",
      ),
    ).length,
    0,
  );
  console.log(
    "PASS: real installer cold upgrade, prompt activation, safe initializing writes, cancellation, QR pairing, audited HTTP and activity previews, encrypted storage, durable receipts, restart and revocation; offline fixture only.",
  );
} finally {
  releaseDownload();
  await manager?.stop();
  database?.db?.close();
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
