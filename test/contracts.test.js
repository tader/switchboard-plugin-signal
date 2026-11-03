import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Ajv } from "ajv";
import { Cache } from "../plugins/signal/lib/cache.js";
import { Service } from "../plugins/signal/lib/service.js";
import { createMessagingContract } from "../plugins/signal/lib/contracts.js";
const account = "11111111-1111-4111-8111-111111111111",
  peer = "22222222-2222-4222-8222-222222222222";
const ajv = new Ajv({ strict: false });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-contract-"));
  const cache = new Cache(dir, account);
  let sends = 0;
  const session = {
    account,
    cache,
    bridge: {
      closed: false,
      async call() {
        sends++;
        return { timestamp: 5000, results: [{ type: "SUCCESS" }] };
      },
    },
  };
  const conn = {
    id: "connection",
    methodId: "linked-device",
    config: { access: "write" },
    credentials: { profile: "profile", cacheId: "cache", account },
  };
  const pool = {
    async session(c) {
      assert.equal(c.credentials.account, account);
      return session;
    },
  };
  const service = new Service({}, pool);
  const contract = createMessagingContract(service, pool);
  t.after(() => {
    if (!cache.closed) cache.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    cache,
    contract,
    session,
    ctx: {
      connection: conn,
      signal: new AbortController().signal,
      idempotencyKey: "fixture-key",
    },
    sends: () => sends,
  };
}
async function call(f, name, input) {
  const op = f.contract.operations[name];
  assert.ok(ajv.validate(op.inputSchema, input), ajv.errorsText());
  const value = await op.invoke(input, f.ctx);
  assert.ok(ajv.validate(op.outputSchema, value), ajv.errorsText());
  return value;
}
function incoming(cache, ts = 1000, data = { message: "hello" }) {
  cache.ingest({
    result: {
      envelope: {
        sourceUuid: peer,
        timestamp: ts,
        dataMessage: { timestamp: ts, ...data },
      },
    },
  });
}
test("cache mutation and feed entry commit together; failed mutation rolls both back", (t) => {
  const f = fixture(t),
    cursor = f.cache.changes().checkpoint;
  incoming(f.cache);
  assert.equal(f.cache.changes(cursor).events.length, 1);
  const head = f.cache.changeHead();
  assert.throws(() =>
    f.cache.mutate(() => {
      f.cache.addChat("direct", "+31612345678", "rollback");
      throw Error("rollback");
    }),
  );
  assert.equal(f.cache.changeHead(), head);
  assert.throws(() => f.cache.chat("d:+31612345678"));
});
test("feed is metadata-only, survives restart and detects expired or foreign cursors", (t) => {
  const f = fixture(t);
  let cursor = f.cache.changes().checkpoint;
  incoming(f.cache, 1000, { message: "DO-NOT-ARCHIVE", viewOnce: true });
  const page = f.cache.changes(cursor);
  assert.equal(page.events.length, 1);
  assert.ok(
    !JSON.stringify(
      f.cache.db.prepare("SELECT * FROM changefeed").all(),
    ).includes("DO-NOT-ARCHIVE"),
  );
  f.cache.close();
  const reopened = new Cache(f.dir, account);
  try {
    assert.deepEqual(reopened.changes(page.checkpoint).events, []);
    assert.equal(
      reopened.changes("foreign").events[0].event.type,
      "resync.required",
    );
    reopened.db.prepare("UPDATE changefeed SET created=0").run();
    assert.equal(
      reopened.changes(cursor).events[0].event.type,
      "resync.required",
    );
  } finally {
    reopened.close();
  }
});
test("duplicate chat discovery does not generate redundant changes", (t) => {
  const f = fixture(t);
  f.cache.addChat("direct", peer, "Name");
  const cursor = f.cache.changes().checkpoint;
  f.cache.addChat("direct", peer, "Name");
  assert.deepEqual(f.cache.changes(cursor).events, []);
});
test("capabilities omit unsupported operations and enforce readonly connections", async (t) => {
  const f = fixture(t);
  assert.equal(f.contract.available(f.ctx.connection).length, 6);
  f.ctx.connection.config.access = "read";
  assert.equal(f.contract.available(f.ctx.connection).length, 4);
  incoming(f.cache);
  const result = await call(f, "messaging.messages.send", {
    conversationId: "d:" + peer,
    text: "no send",
  });
  assert.equal(result.status, "rejected");
  assert.equal(f.sends(), 0);
  assert.ok(!f.contract.operations["messaging.readState.update"]);
  assert.ok(!f.contract.operations["messaging.conversations.create"]);
});
test("history exposes partial coverage and never returns restricted/deleted body text", async (t) => {
  const f = fixture(t);
  incoming(f.cache, 1000);
  incoming(f.cache, 2000, { message: "DO-NOT-ARCHIVE", expiresInSeconds: 60 });
  const chats = await call(f, "messaging.conversations.list", {});
  assert.deepEqual(chats.coverage, {
    complete: false,
    reason: "synced_cache_only",
  });
  assert.equal(chats.items[0].unread, null);
  const messages = await call(f, "messaging.messages.list", {
    conversationId: "d:" + peer,
  });
  assert.equal(messages.items[0].contentState, "restricted");
  assert.equal(messages.items[0].text, null);
  assert.equal(messages.items[1].text, "hello");
  assert.ok(!JSON.stringify(messages).includes("DO-NOT-ARCHIVE"));
  incoming(f.cache, 3000, { remoteDelete: { targetTimestamp: 1000 } });
  const deleted = await call(f, "messaging.messages.get", {
    conversationId: "d:" + peer,
    id: messages.items[1].id,
  });
  assert.equal(deleted.contentState, "deleted");
  assert.equal(deleted.text, null);
});
test("opaque history cursor is bound to the current connection and conversation", async (t) => {
  const f = fixture(t);
  incoming(f.cache, 1000);
  incoming(f.cache, 2000);
  const p = await call(f, "messaging.messages.list", {
    conversationId: "d:" + peer,
    limit: 1,
  });
  assert.ok(p.nextCursor);
  f.ctx.connection.id = "another";
  await assert.rejects(
    () =>
      call(f, "messaging.messages.list", {
        conversationId: "d:" + peer,
        limit: 1,
        cursor: p.nextCursor,
      }),
    { code: "invalid_cursor" },
  );
});
test("send reuses the core key in the nested durable ledger and never archives outgoing text", async (t) => {
  const f = fixture(t);
  incoming(f.cache);
  const args = { conversationId: "d:" + peer, text: "private outgoing" };
  const first = await call(f, "messaging.messages.send", args),
    again = await call(f, "messaging.messages.send", args);
  assert.equal(first.status, "accepted");
  assert.deepEqual(first, again);
  assert.equal(f.sends(), 1);
  assert.ok(
    !fs
      .readFileSync(path.join(f.dir, "cache.db"))
      .includes(Buffer.from("private outgoing")),
  );
  await assert.rejects(
    () => call(f, "messaging.messages.send", { ...args, text: "changed" }),
    { code: "idempotency_conflict" },
  );
  assert.equal(f.sends(), 1);
});
test("uncertain nested dispatch cannot be resent even after recreating the contract", async (t) => {
  const f = fixture(t);
  incoming(f.cache);
  let attempts = 0;
  f.session.bridge.call = async () => {
    attempts++;
    throw Object.assign(Error("uncertain"), { code: "uncertain" });
  };
  const args = { conversationId: "d:" + peer, text: "pending" };
  assert.equal(
    (await call(f, "messaging.messages.send", args)).status,
    "uncertain",
  );
  assert.equal(
    (await call(f, "messaging.messages.send", args)).status,
    "uncertain",
  );
  assert.equal(attempts, 1);
});
test("native watch replays durable changes and removes its listener on abort", async (t) => {
  const f = fixture(t),
    abort = new AbortController(),
    batches = [];
  const task = f.contract.watch(
    {},
    {
      ...f.ctx,
      signal: abort.signal,
      async publish(batch) {
        batches.push(batch);
      },
    },
  );
  await setImmediate();
  assert.equal(batches[0].events[0].event.type, "resync.required");
  incoming(f.cache);
  await setImmediate();
  assert.equal(batches.at(-1).events[0].event.type, "invalidated");
  assert.equal(f.cache.listeners.size, 1);
  abort.abort();
  await assert.rejects(() => task);
  assert.equal(f.cache.listeners.size, 0);
});
test("native watch cannot advance delivery after publish fails", async (t) => {
  const f = fixture(t);
  const checkpoint = f.cache.changes().checkpoint;
  incoming(f.cache);
  let emitted;
  await assert.rejects(
    () =>
      f.contract.watch(
        { checkpoint },
        {
          ...f.ctx,
          async publish(batch) {
            emitted = batch;
            throw Error("commit failed");
          },
        },
      ),
    /commit failed/,
  );
  assert.deepEqual(f.cache.changes(checkpoint).events, emitted.events);
  assert.equal(f.cache.listeners.size, 0);
});

test("pruning cannot delete feed rows without committing the eviction watermark", (t) => {
  const f = fixture(t),
    cursor = f.cache.changes().checkpoint;
  incoming(f.cache);
  f.cache.db.prepare("UPDATE changefeed SET created=0").run();
  f.cache.db.exec(
    "CREATE TRIGGER fail_floor BEFORE UPDATE ON metadata WHEN NEW.key='changeFloor' BEGIN SELECT RAISE(ABORT,'watermark failure');END",
  );
  assert.throws(() => f.cache.changes(cursor), /watermark failure/);
  assert.equal(
    f.cache.db.prepare("SELECT COUNT(*) n FROM changefeed").get().n,
    1,
  );
  f.cache.db.exec("DROP TRIGGER fail_floor");
  assert.equal(f.cache.changes(cursor).events[0].event.type, "resync.required");
});
test("feed retention caps history at 100000 rows and reports the gap", (t) => {
  const f = fixture(t),
    cursor = f.cache.changes().checkpoint;
  f.cache.db
    .prepare(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100002) INSERT INTO changefeed(created) SELECT ? FROM n",
    )
    .run(Date.now());
  assert.equal(f.cache.changes(cursor).events[0].event.type, "resync.required");
  assert.equal(
    f.cache.db.prepare("SELECT COUNT(*) n FROM changefeed").get().n,
    100000,
  );
});

test("duplicate provider deliveries do not append duplicate change notifications", (t) => {
  const f = fixture(t);
  incoming(f.cache);
  const cursor = f.cache.changes().checkpoint;
  incoming(f.cache);
  assert.deepEqual(f.cache.changes(cursor).events, []);
});

test("reply pointers round-trip and restricted quote targets are rejected without dispatch", async (t) => {
  const f = fixture(t);
  incoming(f.cache);
  const target = f.cache.page("messages", { chat: "d:" + peer }).items[0];
  incoming(f.cache, 2000, {
    message: "reply",
    quote: { authorUuid: peer, id: 1000 },
  });
  let items = (
    await call(f, "messaging.messages.list", { conversationId: "d:" + peer })
  ).items;
  assert.equal(items[0].replyToId, target.id);
  incoming(f.cache, 3000, { message: "secret", viewOnce: true });
  items = (
    await call(f, "messaging.messages.list", { conversationId: "d:" + peer })
  ).items;
  assert.deepEqual(
    await call(f, "messaging.messages.send", {
      conversationId: "d:" + peer,
      text: "reply",
      replyToId: items[0].id,
    }),
    { status: "rejected", code: "reply_context_unavailable" },
  );
  assert.equal(f.sends(), 0);
});

test("receive bursts coalesce to one invalidation at the latest durable sequence", (t) => {
  const f = fixture(t),
    cursor = f.cache.changes().checkpoint;
  for (let i = 1; i <= 20; i++) incoming(f.cache, i * 1000);
  const batch = f.cache.changes(cursor);
  assert.equal(batch.events.length, 1);
  assert.equal(
    JSON.parse(Buffer.from(batch.checkpoint, "base64url")).seq,
    f.cache.changeHead(),
  );
  assert.deepEqual(f.cache.changes(batch.checkpoint).events, []);
});
