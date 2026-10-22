import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const core = path.resolve(process.env.SWITCHBOARD_ROOT ?? "");
assert(process.env.SWITCHBOARD_ROOT, "Set SWITCHBOARD_ROOT");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "signal-peers-")),
  children = [];
const wait = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Timed out waiting for peer state");
};
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function launch(role, extra = {}) {
  const data = path.join(scratch, role),
    p = await port(),
    url = "http://127.0.0.1:" + p;
  if (role === "owner") {
    fs.mkdirSync(path.join(data, "plugins"), { recursive: true });
    fs.cpSync("plugins/signal", path.join(data, "plugins/signal"), {
      recursive: true,
    });
  }
  let output = "",
    cookie = "";
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "server/main.ts"],
    {
      cwd: core,
      env: {
        ...process.env,
        SWITCHBOARD_HOST: "127.0.0.1",
        SWITCHBOARD_PORT: String(p),
        SWITCHBOARD_PUBLIC_URL: url,
        SWITCHBOARD_DATA_DIR: data,
        SWITCHBOARD_WATCH_PLUGINS: "false",
        ...extra,
      },
    },
  );
  children.push(child);
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await wait(
    () => output.includes("Switchboard listening") || child.exitCode !== null,
  );
  assert.equal(child.exitCode, null, output);
  const call = async (method, pathname, body) => {
    const r = await fetch(url + pathname, {
      method,
      headers: {
        cookie,
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: r.status, data: await r.json() };
  };
  const token = output.match(/\/invite#(\S+)/)?.[1];
  assert(token, output);
  assert.equal(
    (
      await call("POST", "/api/auth/invite", {
        token,
        password: "temporary Signal peer fixture password",
      })
    ).status,
    200,
  );
  return { data, url, call, child };
}
try {
  const consumer = await launch("consumer");
  const enrollment = await consumer.call("POST", "/api/admin/peers", {
    name: "Signal owner",
  });
  assert.equal(enrollment.status, 201);
  const owner = await launch("owner", {
    SWITCHBOARD_PEER_URL: consumer.url,
    SWITCHBOARD_PEER_TOKEN: enrollment.data.token,
  });
  await wait(
    async () => (await owner.call("GET", "/api/admin/peers")).data[0]?.online,
  );
  assert.equal(
    (
      await owner.call("PUT", "/api/admin/plugins/signal/settings", {
        signalCliPath: path.resolve("test/fixture-helper.cjs"),
      })
    ).status,
    200,
  );
  const flow = await owner.call("POST", "/api/connections", {
    service: "signal",
    method: "linked-device",
    name: "signal-fixture",
    config: { access: "write" },
  });
  assert.equal(flow.status, 200);
  assert.match(flow.data.device.qrCode, /^sgnl:/);
  let connection;
  await wait(async () => {
    const r = await owner.call(
      "POST",
      "/api/connect/" + flow.data.flowId + "/poll",
      {},
    );
    connection = r.data.connection;
    return !!connection;
  });
  assert.equal((await consumer.call("GET", "/api/connections")).data.length, 0);
  const peer = (await owner.call("GET", "/api/admin/peers")).data[0].id;
  assert.equal(
    (
      await owner.call("PUT", "/api/connections/" + connection.id + "/shares", {
        peerIds: [peer],
      })
    ).status,
    200,
  );
  let shared;
  await wait(async () => {
    shared = (await consumer.call("GET", "/api/connections")).data.find(
      (c) => c.name === "signal-fixture",
    );
    return shared?.status === "ok";
  });
  assert.deepEqual(shared.config, {});
  assert.equal(shared.account, null);
  const remote = await consumer.call("POST", "/api/call", {
    connection: shared.id,
    method: "GET",
    url: "/status",
  });
  assert.equal(remote.status, 200, JSON.stringify(remote));
  assert.equal(JSON.parse(remote.data.body).ready, true);
  const chats = await consumer.call("POST", "/api/call", {
    connection: shared.id,
    method: "GET",
    url: "/chats",
  });
  const chat = JSON.parse(chats.data.body).items.find(
    (c) => c.type === "direct",
  ).id;
  const body = {
    chat,
    text: "peer fixture never leaves test helper",
    idempotencyKey: "peer-fixture-send",
  };
  const send = () =>
    consumer.call("POST", "/api/call", {
      connection: shared.id,
      method: "POST",
      url: "/messages",
      headers: [["content-type", "application/json"]],
      body: JSON.stringify(body),
    });
  assert.equal(JSON.parse((await send()).data.body).ok, true);
  assert.equal(JSON.parse((await send()).data.body).replayed, true);
  assert(!fs.existsSync(path.join(consumer.data, "plugin-data/signal")));
  assert.equal(
    (
      await owner.call("PUT", "/api/connections/" + connection.id + "/shares", {
        peerIds: [],
      })
    ).status,
    200,
  );
  await wait(
    async () =>
      (await consumer.call("GET", "/api/connections")).data.find(
        (c) => c.id === shared.id,
      )?.status === "unavailable",
  );
  assert.notEqual(
    (
      await consumer.call("POST", "/api/call", {
        connection: shared.id,
        method: "GET",
        url: "/status",
      })
    ).status,
    200,
  );
  console.log(
    "PASS: two real cores, explicit Peer sharing, remote reads/writes and durable replay, owner-only sessions/cache, and share revocation.",
  );
} finally {
  await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve) => {
          if (c.exitCode !== null) return resolve();
          c.once("close", resolve);
          c.kill();
        }),
    ),
  );
  fs.rmSync(scratch, { recursive: true, force: true });
}
