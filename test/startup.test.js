import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createAdapter } from "../plugins/signal/lib/adapter.js";
import { Pool } from "../plugins/signal/lib/bridge.js";
import { platformKey, ensureRuntime } from "../plugins/signal/lib/runtime.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Startup work blocked activation or disposal")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function saved(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-startup-"));
  const ctx = {
    manifest: { id: "signal", version: "1.2.3" },
    dataDir: path.join(dir, "data"),
    dir: path.resolve("plugins/signal"),
    settings: { signalCliPath: path.resolve("test/fixture-helper.cjs") },
    capabilities: { deviceQr: true },
    log: { warn() {}, info() {}, error() {} },
  };
  const old = await createAdapter(ctx),
    auth = old.services[0].authMethods[0];
  const step = await auth.connect({ config: { access: "write" } });
  let connection;
  for (let i = 0; i < 100; i++) {
    const result = await auth.poll({ pending: step.pending });
    if (!result.wait) {
      connection = result;
      break;
    }
    await sleep(5);
  }
  assert(connection?.credentials);
  await old.dispose();
  const profile = path.join(
    ctx.dataDir,
    "profiles",
    connection.credentials.profile,
  );
  await fs.rm(path.join(profile, "fixture-trace.jsonl"), { force: true });
  ctx.settings = {};
  const tree = path.join(dir, "tree"),
    bin = path.join(tree, "runtime/jre/bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    path.join(bin, "java"),
    "#!/usr/bin/env node\nrequire(" +
      JSON.stringify(path.resolve("test/fixture-helper.cjs")) +
      ");\n",
    { mode: 0o755 },
  );
  const archive = path.join(dir, "runtime.tgz");
  execFileSync("tar", ["-czf", archive, "-C", tree, "runtime"]);
  const bytes = await fs.readFile(archive),
    name = "signal-runtime-" + platformKey() + ".tar.gz";
  const gate = deferred(),
    started = deferred(),
    original = globalThis.fetch,
    cleanups = [];
  let aborted = false;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith("http://127.0.0.1:"))
      return original(url, options);
    if (String(url).endsWith("sha256sums.txt")) {
      started.resolve();
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          aborted = true;
          reject(options.signal.reason);
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        gate.promise.then(() => {
          options.signal.removeEventListener("abort", onAbort);
          resolve();
        });
        if (options.signal.aborted) onAbort();
      });
      return new Response(
        createHash("sha256").update(bytes).digest("hex") + "  " + name + "\n",
      );
    }
    return new Response(bytes);
  };
  t.after(async () => {
    gate.resolve();
    for (const cleanup of cleanups.reverse()) await cleanup();
    globalThis.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    ctx,
    connection,
    profile,
    gate,
    started,
    cleanup: (fn) => cleanups.push(fn),
    aborted: () => aborted,
  };
}
test("cold runtime restoration does not block activation and reports starting before any write", async (t) => {
  const f = await saved(t),
    pool = new Pool(f.ctx),
    creation = createAdapter(f.ctx, { pool });
  f.cleanup(async () => {
    f.gate.resolve();
    await (await creation).dispose();
  });
  const adapter = await bounded(creation);
  await f.started.promise;
  assert.equal(pool.restoring, true);
  const request = {
    method: "POST",
    url: new URL("http://signal.localhost/messages"),
    headers: new Headers(),
  };
  await adapter.services[0].authMethods[0].authorize(request, f.connection);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      chat: "d:22222222-2222-4222-8222-222222222222",
      text: "must not send",
      idempotencyKey: "startup-write-test",
    }),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal((await response.json()).error.code, "helper_starting");
  await assert.rejects(
    () => fs.access(path.join(f.profile, "fixture-trace.jsonl")),
    { code: "ENOENT" },
  );
  f.gate.resolve();
  await bounded(
    (async () => {
      while (pool.restoring) await sleep(5);
    })(),
  );
  const session = await pool.session(f.connection);
  assert.equal(session.account, f.connection.credentials.account);
  assert.equal(session.subscribed, true);
  assert.deepEqual(await session.bridge.call("listAccounts"), [
    { aci: f.connection.credentials.account, number: null },
  ]);
});
test("dispose aborts a cold restore, releases ownership and never starts a late helper", async (t) => {
  const f = await saved(t),
    pool = new Pool(f.ctx),
    adapter = await bounded(createAdapter(f.ctx, { pool }));
  f.cleanup(() => adapter.dispose());
  await f.started.promise;
  await bounded(adapter.dispose());
  assert.equal(f.aborted(), true);
  assert.equal(pool.sessions.size, 0);
  await assert.rejects(() => fs.access(path.join(f.profile, "owner.json")), {
    code: "ENOENT",
  });
  f.gate.resolve();
  await sleep(20);
  await assert.rejects(
    () => fs.access(path.join(f.profile, "fixture-trace.jsonl")),
    { code: "ENOENT" },
  );
  const replacement = new Pool({
    ...f.ctx,
    settings: { signalCliPath: path.resolve("test/fixture-helper.cjs") },
  });
  f.cleanup(() => replacement.close());
  assert.equal(
    (await replacement.session(f.connection)).account,
    f.connection.credentials.account,
  );
});
test("one cancelled waiter does not cancel another owner's shared runtime install", async (t) => {
  const f = await saved(t),
    first = new AbortController(),
    second = new AbortController();
  const a = ensureRuntime(f.ctx, { signal: first.signal }),
    b = ensureRuntime(f.ctx, { signal: second.signal });
  f.cleanup(() => Promise.allSettled([a, b]));
  await f.started.promise;
  // Let both callers finish their cache check and join the shared operation.
  await sleep(50);
  first.abort(Error("cancelled first owner"));
  await assert.rejects(() => a, /cancelled first owner/);
  assert.equal(f.aborted(), false);
  f.gate.resolve();
  const runtime = await b;
  assert.match(await fs.readFile(runtime.executable, "utf8"), /fixture-helper/);
});
