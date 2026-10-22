import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
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
const bytes = fs.readFileSync(archive),
  sha = "b".repeat(40);
globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  if (url.startsWith("https://api.github.com/repos/fixture/signal/")) {
    if (url.includes("/releases")) {
      const r = { tag_name: "v0.0.0", published_at: "2026-10-22T00:00:00Z" };
      return Response.json(url.endsWith("/latest") ? r : [r]);
    }
    if (url.includes("/commits/")) return new Response(sha);
    if (url.includes("/tarball/")) return new Response(bytes);
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
  await manager.stop();
  await manager.start();
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
    "PASS: real installer, plugin manager, QR pairing, proxy, discovery, encrypted connection storage, durable receipts, restart and revocation; offline fixture only.",
  );
} finally {
  await manager?.stop();
  database?.db?.close();
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
