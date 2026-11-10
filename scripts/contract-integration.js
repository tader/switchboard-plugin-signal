// Offline end-to-end contract test: real core HTTP/SSE routes and Signal JSON-RPC fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "../plugins/signal/lib/bridge.js";
import { createAdapter } from "../plugins/signal/lib/adapter.js";
const core = process.env.SWITCHBOARD_ROOT;
assert(core, "Set SWITCHBOARD_ROOT to a core with shared contracts");
const root = path.resolve(core),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "signal-contract-integration-"));
process.env.SWITCHBOARD_SHARED_CONTRACTS = "1";
process.env.SWITCHBOARD_DATA_DIR = path.join(temp, "core");
fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR);
const load = (file) => import(pathToFileURL(path.join(root, file)).href);
const database = await load("server/db.ts");
database.initDb();
const { initKey, encrypt } = await load("server/crypto.ts");
initKey();
const { createUser, createToken } = await load("server/users.ts");
const { plugins } = await load("server/plugins/manager.ts");
const { api } = await load("server/routes/connections.ts");
assert.equal(
  (await load("server/config.ts")).config.sharedContracts,
  true,
  "Enable the core contract feature in this isolated fixture",
);
const { pushSources, collectors } = await load("server/contracts/service.ts");
const { validateDefinition } = await load("server/contracts/model.ts");
const ctx = {
  manifest: JSON.parse(fs.readFileSync("plugins/signal/plugin.json", "utf8")),
  dataDir: path.join(temp, "signal"),
  dir: path.resolve("plugins/signal"),
  settings: { signalCliPath: path.resolve("test/fixture-helper.cjs") },
  log: { warn() {}, info() {}, error() {} },
  capabilities: { deviceQr: true },
};
const pool = new Pool(ctx),
  adapter = await createAdapter(ctx, { pool }),
  service = adapter.services[0];
validateDefinition(service.contracts);
plugins.services.set("signal", { pluginId: "signal", service });
const { serve } = createRequire(path.join(root, "package.json"))(
  "@hono/node-server",
);
let resolveListening;
const listening = new Promise((resolve) => (resolveListening = resolve));
const server = serve(
  { fetch: api.fetch, hostname: "127.0.0.1", port: 0 },
  resolveListening,
);
await listening;
const base = "http://127.0.0.1:" + server.address().port;
const controllers = [];
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error("Fixture condition did not become ready");
}
try {
  const method = service.authMethods[0],
    step = await method.connect({ config: { access: "write" } });
  let connected;
  await until(async () => {
    connected = await method.poll({ pending: step.pending });
    return !connected.wait;
  });
  const user = createUser("contract-fixture", "admin"),
    id = randomUUID();
  const insert = (id, config) =>
    database.run(
      "INSERT INTO connections(id,user_id,service_id,method_id,name,config_enc,credentials_enc,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id,
      user.id,
      "signal",
      method.id,
      id,
      encrypt(config),
      encrypt(connected.credentials),
      "ok",
      Date.now(),
      Date.now(),
    );
  insert(id, connected.config);
  const token = createToken(user.id, "fixture", [id]).secret;
  const request = (url, body, auth = token) =>
    fetch(base + url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + auth,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const call = (operation, args, key) =>
    request("/connections/" + id + "/contracts/v1/call", {
      operation,
      arguments: args,
      ...(key ? { idempotencyKey: key } : {}),
    });
  const descriptor = await (
    await request("/connections/" + id + "/contracts/v1")
  ).json();
  assert.deepEqual(descriptor.changes, { native: true, reconciliation: false });
  assert.equal(
    descriptor.operations.find((o) => o.name === "messaging.messages.send")
      .inputConstraints.properties.text.maxLength,
    4000,
  );
  assert.equal(
    (
      await call("messaging.messages.list", {
        conversationId: "fixture",
        threadId: "unsupported-thread",
      })
    ).status,
    400,
    "unsupported thread filters must not return unfiltered history",
  );
  const session = await pool.session({ credentials: connected.credentials });
  await until(
    () =>
      session.cache.db.prepare("SELECT COUNT(*) n FROM messages").get().n >= 4,
  );
  const conversations = await (
    await call("messaging.conversations.list", {})
  ).json();
  assert.equal(conversations.coverage.complete, false);
  const conversationId = conversations.items.find(
    (c) => c.kind === "direct",
  ).id;
  const history = await (
    await call("messaging.messages.list", { conversationId })
  ).json();
  assert.ok(
    history.items.some(
      (m) => m.contentState === "restricted" && m.text === null,
    ),
  );
  assert.ok(!JSON.stringify(history).includes("DO-NOT-ARCHIVE"));
  const actor = "22222222-2222-4222-8222-222222222222";
  session.cache.addChat("direct", actor, "Fixture contact");
  session.cache.ingest({result:{envelope:{sourceUuid:actor,timestamp:8000,dataMessage:{timestamp:8000,reaction:{targetAuthorUuid:actor,targetSentTimestamp:1000,emoji:"👍"}}}}});
  const reactionsResponse = await call("messaging.messages.list", {conversationId});
  assert.equal(reactionsResponse.status,200);
  const reactionsPage=await reactionsResponse.json();
  const reaction=reactionsPage.items.flatMap(item=>item.reactions??[]).find(item=>item.emoji==="👍");
  assert.deepEqual(reaction.users,[{id:actor,displayName:"Fixture contact"}]);
  assert.equal(reaction.usersComplete,false);
  for (let i = 0; i < 2; i++) {
    const response = await call(
      "messaging.messages.send",
      { conversationId, text: "offline fixture send" },
      "same-core-key",
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "accepted");
  }
  const trace = () =>
    fs
      .readFileSync(path.join(session.dir, "fixture-trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  assert.equal(trace().filter((r) => r.method === "send").length, 1);
  assert.ok(!trace().some((r) => r.method === "sendReadReceipt"));
  assert.equal(
    (
      await call(
        "messaging.messages.send",
        { conversationId, text: "x".repeat(4001) },
        "too-long",
      )
    ).status,
    400,
  );
  const sub = await (
    await request("/contracts/v1/subscriptions", { connections: [id] })
  ).json();
  await request("/contracts/v1/subscriptions/" + sub.id + "/activity", {
    active: true,
  });
  await until(() => session.cache.listeners.size === 1);
  const cursor = Number(
    database.db
      .prepare("SELECT COALESCE(MAX(seq),0) n FROM contract_events")
      .get().n,
  );
  async function stream(after) {
    const abort = new AbortController();
    controllers.push(abort);
    const response = await fetch(
      base + "/contracts/v1/subscriptions/" + sub.id + "/events",
      {
        headers: {
          authorization: "Bearer " + token,
          "last-event-id": String(after),
        },
        signal: abort.signal,
      },
    );
    assert.equal(response.status, 200);
    return { abort, reader: response.body.getReader() };
  }
  async function change(s) {
    let buffer = "";
    const timeout = setTimeout(() => s.abort.abort(), 5000);
    try {
      while (true) {
        const part = await s.reader.read();
        assert.ok(!part.done);
        buffer += new TextDecoder().decode(part.value);
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.includes("event: change"))
            return JSON.parse(
              frame
                .split("\n")
                .find((l) => l.startsWith("data: "))
                .slice(6),
            );
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  const first = await stream(cursor);
  session.cache.ingest({
    result: {
      envelope: {
        sourceUuid: "22222222-2222-4222-8222-222222222222",
        timestamp: 9000,
        dataMessage: { timestamp: 9000, message: "PRIVATE-NATIVE-BODY" },
      },
    },
  });
  const event = await change(first);
  assert.equal(event.connectionId, id);
  assert.equal(event.category, "messaging");
  assert.equal(event.type, "invalidated");
  assert.ok(!JSON.stringify(event).includes("PRIVATE-NATIVE-BODY"));
  first.abort.abort();
  await first.reader.cancel().catch(() => {});
  const replay = await stream(cursor),
    again = await change(replay);
  assert.equal(again.id, event.id);
  replay.abort.abort();
  await replay.reader.cancel().catch(() => {});
  assert.ok(
    !JSON.stringify(
      database.db.prepare("SELECT * FROM contract_events").all(),
    ).includes("PRIVATE-NATIVE-BODY"),
  );
  const readonly = randomUUID();
  insert(readonly, { access: "read" });
  const ro = createToken(user.id, "readonly", [readonly]).secret;
  assert.equal(
    (
      await request(
        "/connections/" + readonly + "/contracts/v1/call",
        {
          operation: "messaging.messages.send",
          arguments: { conversationId, text: "blocked" },
          idempotencyKey: "blocked",
        },
        ro,
      )
    ).status,
    403,
  );
  assert.equal(trace().filter((r) => r.method === "send").length, 1);
  const deleted = await fetch(base + "/contracts/v1/subscriptions/" + sub.id, {
    method: "DELETE",
    headers: { authorization: "Bearer " + token },
  });
  assert.equal(deleted.status, 200);
  await until(() => session.cache.listeners.size === 0);
  console.log(
    "PASS: real core HTTP/SSE with Signal fixture, canonical schema/constraints, safe partial history, durable send replay, native push/replay, readonly enforcement and cleanup",
  );
} finally {
  for (const c of controllers) c.abort();
  await Promise.all([pushSources().stop(), collectors().stop()]);
  await adapter.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  database.db.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
