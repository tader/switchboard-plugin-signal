import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Cache } from "../plugins/signal/lib/cache.js";
import { createAdapter } from "../plugins/signal/lib/adapter.js";
import { checksumFor, platformKey } from "../plugins/signal/lib/runtime.js";
const account = "11111111-1111-4111-8111-111111111111",
  peer = "22222222-2222-4222-8222-222222222222";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(t, capable = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-test-"));
  const ctx = {
    manifest: { id: "signal", version: "0.0.0" },
    dataDir: dir,
    dir: path.resolve("plugins/signal"),
    settings: { signalCliPath: path.resolve("test/fixture-helper.cjs") },
    log: { warn() {}, info() {}, error() {} },
    capabilities: { deviceQr: capable },
  };
  const adapter = await createAdapter(ctx);
  t.after(async () => {
    await adapter.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const service = adapter.services[0],
    auth = service.authMethods[0];
  const connect = async (access = "write") => {
    const step = await auth.connect({ config: { access } });
    assert.equal(step.device.userCode, undefined);
    assert.match(step.device.qrCode, /^sgnl:/);
    let result;
    for (let i = 0; i < 100; i++) {
      result = await auth.poll({ pending: step.pending });
      if (!result.wait) break;
      await wait(10);
    }
    assert(result.credentials);
    const conn = {
      id: randomUUID(),
      serviceId: "signal",
      methodId: "linked-device",
      ...result,
    };
    await wait(30);
    return conn;
  };
  const call = async (conn, method, url, body) => {
    const req = {
      method,
      url: new URL(url, "http://signal.localhost"),
      headers: new Headers(),
    };
    await auth.authorize(req, conn);
    const response = await fetch(req.url, {
      method,
      headers: req.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { dir, ctx, auth, connect, call };
}
test("real subprocess QR flow, cache privacy, direct/group reads, writes and durable receipts", async (t) => {
  const f = await fixture(t),
    conn = await f.connect();
  const chats = await f.call(conn, "GET", "/chats");
  assert.equal(chats.status, 200);
  assert.equal(chats.data.items.length, 2);
  const chat = chats.data.items.find((c) => c.type === "direct").id;
  let page = await f.call(
    conn,
    "GET",
    "/messages?chat=" + encodeURIComponent(chat) + "&limit=1",
  );
  assert.equal(page.data.items[0].type, "restricted");
  assert(!JSON.stringify(page.data).includes("DO-NOT-ARCHIVE"));
  assert(page.data.nextCursor);
  const next = await f.call(
    conn,
    "GET",
    "/messages?chat=" +
      encodeURIComponent(chat) +
      "&limit=1&cursor=" +
      encodeURIComponent(page.data.nextCursor),
  );
  assert.equal(next.data.items[0].type, "poll");
  const poll = next.data.items[0],
    text = (
      await f.call(conn, "GET", "/messages?chat=" + encodeURIComponent(chat))
    ).data.items.find((m) => m.type === "text");
  const send = {
    chat,
    text: "Fixture outgoing",
    replyTo: text.id,
    idempotencyKey: "fixture-send-1",
  };
  assert.equal((await f.call(conn, "POST", "/messages", send)).data.ok, true);
  assert.equal(
    (await f.call(conn, "POST", "/messages", send)).data.replayed,
    true,
  );
  assert.equal(
    (await f.call(conn, "POST", "/messages", { ...send, text: "different" }))
      .status,
    409,
  );
  assert.equal(
    (
      await f.call(conn, "POST", "/reactions", {
        chat,
        messageId: text.id,
        emoji: "👍",
        idempotencyKey: "fixture-react-1",
      })
    ).data.ok,
    true,
  );
  assert.equal(
    (
      await f.call(conn, "POST", "/reactions", {
        chat,
        messageId: text.id,
        emoji: "",
        idempotencyKey: "fixture-react-2",
      })
    ).data.ok,
    true,
  );
  assert.equal(
    (
      await f.call(conn, "POST", "/reactions", {
        chat,
        messageId: text.id,
        emoji: "",
        idempotencyKey: "fixture-react-2",
      })
    ).data.replayed,
    true,
  );
  assert.equal(
    (
      await f.call(conn, "POST", "/polls/vote", {
        chat,
        messageId: poll.id,
        options: ["Two"],
        idempotencyKey: "fixture-vote-1",
      })
    ).data.ok,
    true,
  );
  assert.equal(
    (
      await f.call(conn, "POST", "/polls/vote", {
        chat,
        messageId: poll.id,
        options: [],
        idempotencyKey: "fixture-vote-2",
      })
    ).data.ok,
    true,
  );
  const trace = (
    await fs.readFile(
      path.join(
        f.dir,
        "profiles",
        conn.credentials.profile,
        "fixture-trace.jsonl",
      ),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(trace.filter((r) => r.method === "send").length, 1);
  assert.deepEqual(
    trace
      .filter((r) => r.method === "sendPollVote")
      .map((r) => r.params.voteCount),
    [1, 2],
  );
  assert(!trace.some((r) => /Receipt|Read|Typing|trust/i.test(r.method)));
  const readonly = { ...conn, config: { access: "read" } };
  assert.equal(
    (
      await f.call(readonly, "POST", "/messages", {
        ...send,
        idempotencyKey: "readonly-write",
      })
    ).status,
    403,
  );
  await assert.rejects(
    () =>
      f.call(
        { ...conn, credentials: { ...conn.credentials, account: peer } },
        "GET",
        "/status",
      ),
    /originally/,
  );
  const restricted = (
    await f.call(conn, "GET", "/messages?chat=" + encodeURIComponent(chat))
  ).data.items.find((m) => m.restricted);
  assert.equal(
    (
      await f.call(conn, "POST", "/messages", {
        ...send,
        replyTo: restricted.id,
        idempotencyKey: "restricted-quote",
      })
    ).status,
    409,
  );
});
test("uncertain helper exit never resends a durable attempted write after restart", async (t) => {
  const f = await fixture(t),
    conn = await f.connect(),
    chat = "d:" + peer;
  const input = { chat, text: "uncertain", idempotencyKey: "uncertain-write" };
  assert.equal((await f.call(conn, "POST", "/messages", input)).status, 503);
  assert.equal(
    (await f.call(conn, "GET", "/writes?idempotencyKey=uncertain-write")).data
      .state,
    "attempted",
  );
  assert.equal((await f.call(conn, "POST", "/messages", input)).status, 409);
  const trace = (
    await fs.readFile(
      path.join(
        f.dir,
        "profiles",
        conn.credentials.profile,
        "fixture-trace.jsonl",
      ),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(trace.filter((r) => r.method === "send").length, 1);
});
test("older cores offer an actionable upgrade requirement before starting a helper", async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(
    () => f.auth.connect({ config: { access: "read" } }),
    /Update Switchboard/,
  );
  assert.deepEqual(await fs.readdir(f.dir), []);
});
test("cache scopes cursors and message identity, applies restrictions, deletions and poll closures", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-cache-"));
  const c = new Cache(dir, account);
  t.after(async () => {
    c.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const chat = c.addChat("direct", peer),
    other = c.addChat("direct", account);
  const first = c.store(chat, peer, 100, { message: "text" }),
    second = c.store(chat, account, 100, { message: "other author" });
  assert.notEqual(first.id, second.id);
  const page = c.page("messages", { chat, limit: 1 });
  assert.throws(
    () =>
      c.page("messages", { chat: other, limit: 1, cursor: page.nextCursor }),
    /invalid_cursor/,
  );
  c.ingest({
    envelope: {
      sourceUuid: peer,
      dataMessage: { timestamp: 200, remoteDelete: { timestamp: 100 } },
    },
  });
  assert.equal(c.message(chat, first.id).type, "deleted");
  c.ingest({
    envelope: {
      sourceUuid: peer,
      dataMessage: { timestamp: 250, remoteDelete: { timestamp: 200 } },
    },
  });
  assert.equal(
    c.store(chat, peer, 200, { message: "late deleted body" }).type,
    "deleted",
  );
  const secret = c.store(chat, peer, 300, {
    message: "secret",
    viewOnce: true,
  });
  assert.equal(secret.text, undefined);
  const poll = c.store(chat, peer, 400, {
    pollCreate: { question: "Q", options: ["A"], allowMultiple: false },
  });
  c.ingest({
    envelope: {
      sourceUuid: peer,
      dataMessage: {
        timestamp: 500,
        pollTerminate: { targetSentTimestamp: 400 },
      },
    },
  });
  assert.equal(c.message(chat, poll.id).poll.closed, true);
});
test("platform selection and checksum verification fail closed", () => {
  assert.equal(platformKey("darwin", "arm64", undefined), "darwin-arm64");
  assert.equal(platformKey("linux", "x64", "2.36"), "linux-amd64");
  assert.throws(() => platformKey("linux", "arm64", undefined), /glibc Linux/);
  assert.throws(() => platformKey("win32", "x64", undefined), /glibc Linux/);
  const hash = "a".repeat(64);
  assert.equal(checksumFor(hash + "  file.tar.gz\n", "file.tar.gz"), hash);
  assert.throws(
    () => checksumFor(hash + "  other.tar.gz\n", "file.tar.gz"),
    /checksum/,
  );
  assert.throws(
    () => checksumFor((hash + "  file.tar.gz\n").repeat(2), "file.tar.gz"),
    /checksum/,
  );
});
