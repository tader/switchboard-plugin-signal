import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureRuntime } from "./runtime.js";
import { Cache } from "./cache.js";
import { fail } from "./errors.js";
export class Bridge {
  constructor(runtime, dir, onReceive = () => {}) {
    this.pending = new Map();
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.closed = false;
    this.child = spawn(
      runtime.executable,
      [
        ...runtime.prefix,
        "--disable-send-log",
        "--config",
        dir,
        "jsonRpc",
        "--receive-mode=manual",
        "--ignore-attachments",
        "--ignore-stories",
        "--ignore-avatars",
        "--ignore-stickers",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
    const broken = () => this.fail();
    this.child.on("error", broken);
    this.child.on("exit", broken);
    this.child.stdin.on("error", broken);
    this.child.stdout.on("data", (chunk) => {
      this.buffer += this.decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) {
        this.fail();
        this.child.kill();
        return;
      }
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          this.fail();
          this.child.kill();
          return;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          this.fail();
          this.child.kill();
          return;
        }
        if (value.method === "receive") {
          try {
            onReceive(value.params);
          } catch {
            this.lastError = "invalid_receive_event";
          }
          continue;
        }
        const entry = this.pending.get(value.id);
        if (!entry) continue;
        this.pending.delete(value.id);
        clearTimeout(entry.timer);
        if (value.error) {
          const identity = /untrusted|identity/i.test(
            JSON.stringify(value.error),
          );
          entry.reject(
            fail(identity ? "identity_changed" : "helper_failed", 502),
          );
        } else entry.resolve(value.result);
      }
    });
  }
  call(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(fail("helper_unavailable", 503));
    if (this.pending.size >= 128)
      return Promise.reject(fail("helper_busy", 503));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail("helper_timeout", 504));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  fail() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(fail("helper_unavailable", 503));
    }
    this.pending.clear();
  }
  async close() {
    this.fail();
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await this.exited;
    clearTimeout(timer);
  }
}
export class Pool {
  constructor(ctx) {
    this.ctx = ctx;
    this.helpers = new Map();
    this.caches = new Map();
    this.closed = false;
  }
  profile(id) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw fail("invalid_profile", 401);
    return path.join(this.ctx.dataDir, "profiles", id);
  }
  cacheDir(id) {
    this.profile(id); // Cache handles use the same UUID validation as device profiles.
    return path.join(this.ctx.dataDir, "caches", id);
  }
  async get(id) {
    if (this.closed) throw fail("plugin_unavailable", 503);
    let existing = this.helpers.get(id);
    if (existing) {
      const session = await existing;
      if (!session.bridge.closed) return session;
      if (this.helpers.get(id) !== existing) return this.get(id);
      const replacement = this.release(session).then(() => {
        if (this.helpers.get(id) === replacement) this.helpers.delete(id);
        return this.get(id);
      });
      this.helpers.set(id, replacement);
      return replacement;
    }
    const promise = (async () => {
      const dir = this.profile(id);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      const runtime = await ensureRuntime(this.ctx),
        lock = path.join(dir, "owner.json");
      try {
        const handle = await fs.open(lock, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        await handle.close();
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let alive = true;
        try {
          const old = JSON.parse(await fs.readFile(lock, "utf8"));
          process.kill(old.pid, 0);
        } catch (e) {
          if (e.code === "ESRCH" || e instanceof SyntaxError) alive = false;
          else throw fail("session_in_use", 409);
        }
        if (alive) throw fail("session_in_use", 409);
        await fs.unlink(lock);
        const handle = await fs.open(lock, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        await handle.close();
      }
      const s = {
        profile: id,
        dir,
        lock,
        account: null,
        cache: null,
        subscribed: false,
        lastEventAt: null,
      };
      try {
        s.bridge = new Bridge(runtime, dir, (params) => {
          s.lastEventAt = Date.now();
          s.cache?.ingest(params);
        });
        const accounts = await s.bridge.call("listAccounts");
        let marker;
        try {
          marker = JSON.parse(
            await fs.readFile(path.join(dir, "active.json"), "utf8"),
          );
        } catch {}
        const account = Array.isArray(accounts)
          ? accounts.find((a) => a.aci === marker?.account)
          : null;
        if (marker && !account) throw fail("signin_required", 401);
        if (account) await this.activate(s, account, marker.cacheId ?? id);
        if (this.closed) throw fail("plugin_unavailable", 503);
        return s;
      } catch (e) {
        await this.release(s);
        throw e;
      }
    })();
    this.helpers.set(id, promise);
    try {
      return await promise;
    } catch (e) {
      if (this.helpers.get(id) === promise) this.helpers.delete(id);
      throw e;
    }
  }
  async activate(s, account, cacheId) {
    if (!/^[a-f0-9-]{36}$/i.test(account.aci ?? ""))
      throw fail("pairing_failed", 502);
    s.account = account.aci;
    s.label = account.number ?? account.aci;
    if (!s.cache) {
      const dir = this.cacheDir(cacheId);
      let entry = this.caches.get(cacheId);
      if (entry && entry.cache.account !== s.account)
        throw fail("account_mismatch", 403);
      if (!entry) {
        entry = { cache: new Cache(dir, s.account), references: 0 };
        this.caches.set(cacheId, entry);
      }
      entry.references++;
      s.cacheId = cacheId;
      s.cache = entry.cache;
    }
    if (!s.subscribed) {
      await s.bridge.call("subscribeReceive");
      s.subscribed = true;
      // Contact/group discovery is best effort. Receiving remains active if offline.
      for (const method of ["listContacts", "listGroups"]) {
        try {
          const values = await s.bridge.call(
            method,
            { account: s.account },
            10000,
          );
          if (Array.isArray(values))
            for (const v of values) {
              const addr =
                v.uuid ??
                v.aci ??
                v.number ??
                v.recipientAddress?.uuid ??
                v.recipientAddress?.number;
              s.cache.addChat(
                method === "listGroups" ? "group" : "direct",
                method === "listGroups" ? v.id : addr,
                v.name ?? "",
              );
            }
        } catch {
          s.discoveryIncomplete = true;
        }
      }
    }
    return s;
  }
  async session(conn) {
    const s = await this.get(conn.credentials.profile);
    if (!s.account) throw fail("signin_required", 401);
    if (
      s.account !== conn.credentials.account ||
      s.cacheId !== conn.credentials.cacheId
    )
      throw fail("account_mismatch", 403);
    return s;
  }
  async release(s) {
    await s.bridge?.close();
    if (s.cache) {
      const entry = this.caches.get(s.cacheId);
      if (entry && --entry.references === 0) {
        entry.cache.close();
        this.caches.delete(s.cacheId);
      }
      s.cache = null;
    }
    await fs.rm(s.lock, { force: true });
  }
  async drop(id) {
    const pending = this.helpers.get(id);
    this.helpers.delete(id);
    if (pending) {
      try {
        await this.release(await pending);
      } catch {}
    }
    await fs.rm(this.profile(id), { recursive: true, force: true });
  }
  async dropCache(id) {
    if (this.caches.has(id)) throw fail("session_in_use", 409);
    await fs.rm(this.cacheDir(id), { recursive: true, force: true });
  }
  async restore() {
    const root = path.join(this.ctx.dataDir, "profiles");
    let ids;
    try {
      ids = await fs.readdir(root);
    } catch {
      return;
    }
    for (const id of ids) {
      try {
        await fs.access(path.join(this.profile(id), "active.json"));
        await this.get(id);
      } catch {
        this.ctx.log.warn(
          "A saved Signal session is unavailable; reconnect it if necessary.",
        );
      }
    }
  }
  async close() {
    this.closed = true;
    const all = [...this.helpers.values()];
    this.helpers.clear();
    for (const item of all) {
      try {
        await this.release(await item);
      } catch {}
    }
  }
}
