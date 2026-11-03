import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
export const digest = (value) =>
  createHash("sha256").update(value).digest("base64url");
const identity = (x) => String(x ?? "").replace(/^aci:/, "");
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const validAddress = (x) =>
  /^[a-f0-9-]{36}$/i.test(x) || /^\+[1-9]\d{6,14}$/.test(x);
export class Cache {
  constructor(dir, account) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.account = account;
    this.listeners = new Set();
    this.mutationDepth = 0;
    this.closed = false;
    this.db = new DatabaseSync(path.join(dir, "cache.db"));
    fs.chmodSync(path.join(dir, "cache.db"), 0o600);
    this.db.exec(
      "PRAGMA journal_mode=DELETE;PRAGMA secure_delete=ON;PRAGMA synchronous=FULL;PRAGMA busy_timeout=3000;" +
        "CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,kind TEXT NOT NULL,target TEXT NOT NULL,name TEXT NOT NULL,updated INTEGER NOT NULL DEFAULT 0);" +
        "CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,chat TEXT NOT NULL,author TEXT NOT NULL,ts INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(chat,author,ts));" +
        "CREATE INDEX IF NOT EXISTS message_page ON messages(chat,ts,id);" +
        "CREATE TABLE IF NOT EXISTS tombstones(chat TEXT NOT NULL,author TEXT NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(chat,author,ts));" +
        "CREATE TABLE IF NOT EXISTS votes(poll TEXT PRIMARY KEY,counter INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS writes(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT);" +
        "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);" +
        "CREATE TABLE IF NOT EXISTS changefeed(seq INTEGER PRIMARY KEY AUTOINCREMENT,created INTEGER NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS changefeed_created ON changefeed(created);" +
        "INSERT OR IGNORE INTO metadata VALUES('createdAt',strftime('%s','now'));",
    );
    const owner = this.db
      .prepare("SELECT value FROM metadata WHERE key='account'")
      .get();
    if (owner && owner.value !== account) {
      this.db.close();
      throw fail("account_mismatch", 403);
    }
    this.db
      .prepare("INSERT OR IGNORE INTO metadata VALUES('account',?)")
      .run(account);
  }
  mutate(fn) {
    if (this.closed) throw fail("plugin_unavailable", 503);
    if (this.mutationDepth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.mutationDepth++;
    let result,
      changed = false;
    try {
      const before = this.db.prepare("SELECT total_changes() n").get().n;
      result = fn();
      changed = this.db.prepare("SELECT total_changes() n").get().n > before;
      if (changed) {
        this.db
          .prepare("INSERT INTO changefeed(created) VALUES(?)")
          .run(Date.now());
        this.pruneChanges();
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.mutationDepth--;
    }
    if (changed)
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {}
      }
    return result;
  }
  pruneChanges() {
    if (this.mutationDepth) return this._pruneChanges();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this._pruneChanges();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  _pruneChanges() {
    const expired = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq),0) seq FROM changefeed INDEXED BY changefeed_created WHERE created<?",
      )
      .get(Date.now() - 7 * 86400000).seq;
    const over = Math.max(
      0,
      Number(
        this.db.prepare("SELECT COALESCE(MAX(seq),0) n FROM changefeed").get()
          .n,
      ) - 100000,
    );
    const floor = Math.max(
      expired,
      over,
      Number(
        this.db
          .prepare("SELECT value FROM metadata WHERE key='changeFloor'")
          .get()?.value ?? 0,
      ),
    );
    this.db.prepare("DELETE FROM changefeed WHERE seq<=?").run(floor);
    this.db
      .prepare(
        "INSERT INTO metadata VALUES('changeFloor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE metadata.value<>excluded.value",
      )
      .run(String(floor));
  }
  changeHead() {
    return Math.max(
      Number(
        this.db.prepare("SELECT COALESCE(MAX(seq),0) n FROM changefeed").get()
          .n,
      ),
      Number(
        this.db
          .prepare("SELECT value FROM metadata WHERE key='changeFloor'")
          .get()?.value ?? 0,
      ),
    );
  }
  changes(checkpoint, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw fail("invalid_input", 400);
    if (this.closed) throw fail("plugin_unavailable", 503);
    this.pruneChanges();
    let epoch = this.db
      .prepare("SELECT value FROM metadata WHERE key='changeEpoch'")
      .get()?.value;
    if (!epoch) {
      epoch = randomUUID();
      this.db
        .prepare("INSERT INTO metadata VALUES('changeEpoch',?)")
        .run(epoch);
    }
    const head = this.changeHead(),
      floor = Number(
        this.db
          .prepare("SELECT value FROM metadata WHERE key='changeFloor'")
          .get()?.value ?? 0,
      );
    let old;
    try {
      old = checkpoint
        ? JSON.parse(Buffer.from(checkpoint, "base64url").toString())
        : null;
    } catch {}
    const resync =
      !old ||
      old.epoch !== epoch ||
      !Number.isSafeInteger(old.seq) ||
      old.seq < floor ||
      old.seq > head;
    const rows = resync
      ? []
      : this.db
          .prepare(
            "SELECT seq FROM changefeed WHERE seq>? ORDER BY seq LIMIT ?",
          )
          .all(old.seq, limit);
    const seq = resync ? head : (rows.at(-1)?.seq ?? old.seq);
    return {
      checkpoint: Buffer.from(JSON.stringify({ epoch, seq })).toString(
        "base64url",
      ),
      events: resync
        ? [
            {
              sourceId: `signal:${epoch}:resync:${seq}`,
              event: {
                category: "messaging",
                type: "resync.required",
                resourceType: "conversations",
              },
            },
          ]
        : rows.map((r) => ({
            sourceId: `signal:${epoch}:${r.seq}`,
            event: {
              category: "messaging",
              type: "invalidated",
              resourceType: "conversations",
              version: String(r.seq),
            },
          })),
    };
  }
  waitForChange(checkpoint, signal, timeoutMs = 30000) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let timer;
      const done = (error) => {
        clearTimeout(timer);
        this.listeners.delete(wake);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const wake = () => done(),
        abort = () => done(signal.reason ?? Error("aborted"));
      this.listeners.add(wake);
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (
          this.closed ||
          this.changes(checkpoint).events.length ||
          signal.aborted
        ) {
          done(signal.aborted ? signal.reason : undefined);
          return;
        }
      } catch (error) {
        done(error);
        return;
      }
      timer = setTimeout(wake, timeoutMs);
    });
  }
  addChat(...args) {
    return this.mutate(() => this._addChat(...args));
  }
  store(...args) {
    return this.mutate(() => this._store(...args));
  }
  updateTarget(...args) {
    return this.mutate(() => this._updateTarget(...args));
  }
  ingest(...args) {
    return this.mutate(() => this._ingest(...args));
  }
  _addChat(kind, target, name = "") {
    target = identity(target);
    if (
      (kind === "direct" && !validAddress(target)) ||
      (kind === "group" && !/^[A-Za-z0-9+/=_-]{8,128}$/.test(target))
    )
      return null;
    const id = (kind === "group" ? "g:" : "d:") + target;
    this.db
      .prepare(
        "INSERT INTO chats(id,kind,target,name) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE excluded.name<>'' AND excluded.name<>chats.name",
      )
      .run(id, kind, target, String(name).slice(0, 256));
    return id;
  }
  chat(id) {
    const row = this.db.prepare("SELECT * FROM chats WHERE id=?").get(id);
    if (!row) throw fail("chat_not_in_synced_cache", 404);
    return row;
  }
  message(chat, id) {
    const row = this.db
      .prepare("SELECT payload FROM messages WHERE chat=? AND id=?")
      .get(chat, id);
    if (!row) throw fail("message_not_in_synced_cache", 404);
    return JSON.parse(row.payload);
  }
  _store(chat, author, ts, data, outgoing = false) {
    if (!chat || !validAddress(author) || !Number.isSafeInteger(ts) || ts < 1)
      return null;
    const id = digest(JSON.stringify([this.account, chat, author, ts]));
    const restricted = !!data.viewOnce || Number(data.expiresInSeconds) > 0;
    const poll =
      !restricted && data.pollCreate && Array.isArray(data.pollCreate.options)
        ? {
            question: data.pollCreate.question,
            options: data.pollCreate.options,
            allowMultiple: !!data.pollCreate.allowMultiple,
            closed: false,
          }
        : undefined;
    let item = {
      id,
      chat,
      author,
      timestamp: ts,
      outgoing,
      restricted,
      type: restricted
        ? "restricted"
        : poll
          ? "poll"
          : data.attachments?.length
            ? "media"
            : "text",
      ...(!restricted && typeof data.message === "string"
        ? { text: data.message }
        : {}),
      ...(poll ? { poll } : {}),
      ...(!restricted && data.quote
        ? {
            quote: {
              author: identity(
                data.quote.authorUuid ??
                  data.quote.authorNumber ??
                  data.quote.author,
              ),
              timestamp: data.quote.id,
            },
          }
        : {}),
    };
    if (
      this.db
        .prepare("SELECT 1 FROM tombstones WHERE chat=? AND author=? AND ts=?")
        .get(chat, author, ts)
    )
      item = {
        id,
        chat,
        author,
        timestamp: ts,
        outgoing,
        restricted: true,
        type: "deleted",
      };
    this.db
      .prepare(
        "INSERT INTO messages VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE json_extract(excluded.payload,'$.restricted')=1 AND messages.payload<>excluded.payload",
      )
      .run(id, chat, author, ts, JSON.stringify(item));
    this.db
      .prepare("UPDATE chats SET updated=? WHERE id=? AND updated<?")
      .run(ts, chat, ts);
    return item;
  }
  _updateTarget(chat, author, ts, change) {
    const row = this.db
      .prepare(
        "SELECT id,payload FROM messages WHERE chat=? AND author=? AND ts=?",
      )
      .get(chat, identity(author), ts);
    if (row) {
      const payload = JSON.stringify(change(JSON.parse(row.payload)));
      if (payload !== row.payload)
        this.db
          .prepare("UPDATE messages SET payload=? WHERE id=?")
          .run(payload, row.id);
    }
  }
  _ingest(params) {
    const r = params?.result ?? params,
      env = r?.envelope;
    if (!env) return;
    const sent = env.syncMessage?.sentMessage,
      data = sent ?? env.dataMessage;
    if (!data) return;
    const author = identity(
      sent ? this.account : (env.sourceUuid ?? env.sourceNumber ?? env.source),
    );
    const peer = sent
      ? (sent.destinationUuid ?? sent.destinationNumber ?? sent.destination)
      : author;
    const group = data.groupInfo?.groupId;
    const chat = this.addChat(
      group ? "group" : "direct",
      group ?? peer,
      group ? "" : (env.sourceName ?? ""),
    );
    if (!chat) return;
    const ts = Number(data.timestamp ?? env.timestamp);
    if (data.remoteDelete || data.adminDelete) {
      const deletion = data.remoteDelete ?? data.adminDelete;
      const targetAuthor = identity(
        data.adminDelete
          ? (deletion.targetAuthorUuid ??
              deletion.targetAuthorNumber ??
              deletion.targetAuthor)
          : author,
      );
      const targetTs =
        deletion.targetTimestamp ??
        deletion.timestamp ??
        deletion.targetSentTimestamp;
      if (!validAddress(targetAuthor) || !Number.isSafeInteger(targetTs))
        return;
      this.db
        .prepare("INSERT OR IGNORE INTO tombstones VALUES(?,?,?)")
        .run(chat, targetAuthor, targetTs);
      this.updateTarget(chat, targetAuthor, targetTs, (m) => ({
        id: m.id,
        chat: m.chat,
        author: m.author,
        timestamp: m.timestamp,
        outgoing: m.outgoing,
        type: "deleted",
        restricted: true,
      }));
      return;
    }
    if (data.reaction) {
      const q = data.reaction;
      this.updateTarget(
        chat,
        q.targetAuthorUuid ?? q.targetAuthorNumber ?? q.targetAuthor,
        q.targetSentTimestamp,
        (m) => {
          if (m.restricted) return m;
          const reactions = { ...m.reactions };
          if (q.isRemove) delete reactions[author];
          else reactions[author] = q.emoji;
          return { ...m, reactions };
        },
      );
      return;
    }
    if (data.pollTerminate) {
      this.updateTarget(
        chat,
        author,
        data.pollTerminate.targetSentTimestamp,
        (m) => (m.poll ? { ...m, poll: { ...m.poll, closed: true } } : m),
      );
      return;
    }
    if (data.pollVote) {
      const v = data.pollVote;
      const targetAuthor = identity(v.authorUuid ?? v.authorNumber ?? v.author);
      if (author === this.account) {
        const row = this.db
          .prepare("SELECT id FROM messages WHERE chat=? AND author=? AND ts=?")
          .get(chat, targetAuthor, v.targetSentTimestamp);
        if (row)
          this.db
            .prepare(
              "INSERT INTO votes VALUES(?,?) ON CONFLICT(poll) DO UPDATE SET counter=max(counter,excluded.counter)",
            )
            .run(row.id, v.voteCount);
      }
      return;
    }
    if (
      typeof data.message === "string" ||
      data.pollCreate ||
      data.attachments?.length ||
      data.viewOnce
    )
      this.store(chat, author, ts, data, !!sent);
  }
  page(kind, input) {
    const filter =
      kind === "messages"
        ? { chat: input.chat }
        : { type: input.type ?? "all" };
    let after = null;
    if (input.cursor) {
      try {
        after = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (
          after.account !== this.account ||
          after.kind !== kind ||
          JSON.stringify(after.filter) !== JSON.stringify(filter) ||
          !Number.isSafeInteger(after.ts) ||
          typeof after.id !== "string"
        )
          throw Error();
      } catch {
        throw fail("invalid_cursor", 400);
      }
    }
    const limit = input.limit ?? 50;
    let rows;
    if (kind === "messages") {
      this.chat(input.chat);
      rows = this.db
        .prepare(
          "SELECT id,ts,payload FROM messages WHERE chat=? AND (? IS NULL OR ts<? OR (ts=? AND id<?)) ORDER BY ts DESC,id DESC LIMIT ?",
        )
        .all(
          input.chat,
          after?.ts ?? null,
          after?.ts ?? 0,
          after?.ts ?? 0,
          after?.id ?? "",
          limit + 1,
        );
    } else {
      rows = this.db
        .prepare(
          "SELECT *,updated ts FROM chats WHERE (?='all' OR kind=?) AND (? IS NULL OR updated<? OR (updated=? AND id<?)) ORDER BY updated DESC,id DESC LIMIT ?",
        )
        .all(
          filter.type,
          filter.type,
          after?.ts ?? null,
          after?.ts ?? 0,
          after?.ts ?? 0,
          after?.id ?? "",
          limit + 1,
        );
    }
    const more = rows.length > limit,
      selected = rows.slice(0, limit),
      last = selected.at(-1);
    return {
      items: selected.map((r) =>
        kind === "messages"
          ? JSON.parse(r.payload)
          : { id: r.id, type: r.kind, name: r.name, lastMessageAt: r.updated },
      ),
      hasMore: more,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              account: this.account,
              kind,
              filter,
              ts: last.ts,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
      coverage: "synced_cache_only",
    };
  }
  nextVote(id) {
    this.db
      .prepare(
        "INSERT INTO votes VALUES(?,1) ON CONFLICT(poll) DO UPDATE SET counter=counter+1",
      )
      .run(id);
    return this.db.prepare("SELECT counter FROM votes WHERE poll=?").get(id)
      .counter;
  }
  inspect(key) {
    const row = this.db
      .prepare("SELECT state,result FROM writes WHERE key=?")
      .get(digest(key));
    return row
      ? {
          state: row.state,
          ...(row.result ? { result: JSON.parse(row.result) } : {}),
        }
      : { state: "unknown" };
  }
  replay(key, payload) {
    const previous = this.db
      .prepare("SELECT * FROM writes WHERE key=?")
      .get(digest(key));
    if (!previous) return null;
    if (previous.fingerprint !== digest(canonical(payload)))
      throw fail("idempotency_conflict", 409);
    if (previous.state !== "accepted") throw fail("uncertain", 409);
    return { ...JSON.parse(previous.result), replayed: true };
  }
  async write(key, payload, send) {
    const k = digest(key),
      fingerprint = digest(canonical(payload));
    const previous = this.db.prepare("SELECT * FROM writes WHERE key=?").get(k);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw fail("idempotency_conflict", 409);
      if (previous.state === "accepted")
        return { ...JSON.parse(previous.result), replayed: true };
      throw fail("uncertain", 409);
    }
    if (this.db.prepare("SELECT count(*) n FROM writes").get().n >= 10000)
      throw fail("ledger_full", 503);
    this.db
      .prepare("INSERT INTO writes VALUES(?,?,'attempted',NULL)")
      .run(k, fingerprint);
    const result = await send();
    this.db
      .prepare("UPDATE writes SET state='accepted',result=? WHERE key=?")
      .run(JSON.stringify(result), k);
    return result;
  }
  close() {
    this.closed = true;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
    this.listeners.clear();
    this.db.close();
  }
}
