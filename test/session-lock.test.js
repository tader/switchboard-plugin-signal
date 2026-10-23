import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Pool } from "../plugins/signal/lib/bridge.js";

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-lock-test-"));
  const ctx = {
    dataDir,
    manifest: { version: "1.0.1" },
    settings: { signalCliPath: path.resolve("test/fixture-helper.cjs") },
    log: { warn() {} },
  };
  const pools = [];
  const pool = () => {
    const p = new Pool(ctx);
    pools.push(p);
    return p;
  };
  t.after(async () => {
    for (const p of pools) await p.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { ctx, dataDir, pool };
}

test("a stale legacy marker with the restarted container's PID does not block startup", async (t) => {
  const f = await fixture(t),
    p = f.pool(),
    id = randomUUID();
  const dir = p.profile(id),
    marker = path.join(dir, "owner.json");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(marker, JSON.stringify({ pid: process.pid }));
  await fs.utimes(marker, new Date(0), new Date(0));
  const session = await p.get(id);
  assert.deepEqual(await session.bridge.call("listAccounts"), []);
  const owner = JSON.parse(await fs.readFile(marker, "utf8"));
  assert.equal(owner.lockVersion, 2);
});

test("a live legacy owner remains protected during migration", async (t) => {
  const f = await fixture(t),
    p = f.pool(),
    id = randomUUID();
  const dir = p.profile(id),
    marker = path.join(dir, "owner.json");
  await fs.mkdir(dir, { recursive: true });
  const contents = JSON.stringify({ pid: process.pid });
  await fs.writeFile(marker, contents);
  const future = new Date(Date.now() + 60000);
  await fs.utimes(marker, future, future);
  await assert.rejects(() => p.get(id), { code: "session_in_use" });
  await assert.rejects(() => p.drop(id), { code: "session_in_use" });
  assert.equal(await fs.readFile(marker, "utf8"), contents);
});

test("two pools cannot open or delete the same live profile; ownership transfers after close", async (t) => {
  const f = await fixture(t),
    first = f.pool(),
    second = f.pool(),
    id = randomUUID();
  const sessions = await Promise.all(
    Array.from({ length: 8 }, () => first.get(id)),
  );
  assert(sessions.every((s) => s === sessions[0]));
  const marker = path.join(first.profile(id), "owner.json");
  const owner = await fs.readFile(marker, "utf8");
  await assert.rejects(() => second.get(id), { code: "session_in_use" });
  await assert.rejects(() => second.drop(id), { code: "session_in_use" });
  assert.equal(await fs.readFile(marker, "utf8"), owner);
  assert.deepEqual(await sessions[0].bridge.call("listAccounts"), []);
  await first.close();
  const replacement = await second.get(id);
  assert.deepEqual(await replacement.bridge.call("listAccounts"), []);
  assert.notEqual(await fs.readFile(marker, "utf8"), owner);
  const before = await fs.stat(path.join(f.dataDir, "locks", id + ".lock"));
  await second.drop(id);
  await assert.rejects(() => fs.access(first.profile(id)), { code: "ENOENT" });
  const after = await fs.stat(path.join(f.dataDir, "locks", id + ".lock"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o600);
});

test("the helper retains its lock after owner SIGKILL, then recovery works without PID-file deletion", async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    p = f.pool();
  const helper = path.join(f.dataDir, "sticky-helper.cjs");
  await fs.writeFile(
    helper,
    (await fs.readFile(path.resolve("test/fixture-helper.cjs"), "utf8")) +
      "\nsetInterval(()=>{},1000);\n",
    { mode: 0o700 },
  );
  const ctx = { ...f.ctx, settings: { signalCliPath: helper } };
  const source = `import {Pool} from ${JSON.stringify(new URL("../plugins/signal/lib/bridge.js", import.meta.url).href)}; const ctx=${JSON.stringify(ctx)}; ctx.log={warn(){}}; const p=new Pool(ctx); const s=await p.get(${JSON.stringify(id)}); console.log(JSON.stringify({helper:s.bridge.child.pid}));`;
  const owner = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      source,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let helperPid;
  t.after(() => {
    owner.kill("SIGKILL");
    if (helperPid) {
      try {
        process.kill(helperPid, "SIGKILL");
      } catch {}
    }
  });
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Fixture owner startup timeout")),
      10000,
    );
    let buffer = "";
    owner.once("error", reject);
    owner.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Fixture owner exited before reporting startup"));
    });
    owner.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        clearTimeout(timer);
        resolve(buffer.split("\n")[0]);
      }
    });
  });
  helperPid = JSON.parse(line).helper;
  const exited = once(owner, "exit");
  owner.kill("SIGKILL");
  await exited;
  process.kill(helperPid, 0);
  await assert.rejects(() => p.get(id), { code: "session_in_use" });
  process.kill(helperPid, "SIGKILL");
  let session;
  for (let i = 0; i < 100; i++) {
    try {
      session = await p.get(id);
      break;
    } catch (error) {
      if (error.code !== "session_in_use") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert(session, "Lock was not released after helper termination");
  assert.deepEqual(await session.bridge.call("listAccounts"), []);
  helperPid = undefined;
});

test("startup errors release ownership so a corrected runtime can start", async (t) => {
  const f = await fixture(t),
    p = f.pool(),
    id = randomUUID();
  f.ctx.settings.signalCliPath = path.join(f.dataDir, "missing-helper");
  await assert.rejects(() => p.get(id));
  f.ctx.settings.signalCliPath = path.resolve("test/fixture-helper.cjs");
  assert.deepEqual(await (await p.get(id)).bridge.call("listAccounts"), []);
});
