import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
export function createAuth(pool) {
  const pending = new Map();
  const timer = setInterval(() => {
    for (const [id, f] of pending)
      if (f.expires < Date.now()) {
        pending.delete(id);
        void pool.drop(f.profile).catch(() => {});
      }
  }, 10000);
  timer.unref();
  async function finish(f, s) {
    if (f.previous && s.account !== f.previous) {
      await pool.drop(f.profile);
      throw fail("account_mismatch", 403);
    }
    await fs.writeFile(
      path.join(s.dir, "active.json"),
      JSON.stringify({ account: s.account }),
      { mode: 0o600 },
    );
    if (f.oldProfile && f.oldProfile !== f.profile)
      await pool.drop(f.oldProfile);
    return {
      credentials: { profile: f.profile, account: s.account },
      account: { id: s.account, label: s.label },
      config: { access: f.access === "write" ? "write" : "read" },
    };
  }
  return {
    method: {
      id: "linked-device",
      name: "Link Signal with a QR code",
      description:
        "On your phone, open Signal → Settings → Linked devices and scan the QR code.",
      fields: [
        {
          key: "access",
          label: "Access",
          type: "select",
          default: "read",
          options: [
            { value: "read", label: "Read only" },
            { value: "write", label: "Read, send, reply, react and vote" },
          ],
        },
        {
          key: "relink",
          label: "Link a replacement device",
          type: "boolean",
          advanced: true,
          default: false,
          description:
            "Use if this linked device was revoked. The same account must approve replacement.",
        },
      ],
      async connect({ config, connection }) {
        if (!pool.ctx.capabilities?.deviceQr)
          throw fail("core_upgrade_required", 503);
        if (pending.size >= 8) throw fail("too_many_signins", 503);
        if (connection && !config.relink) {
          const s = await pool.session(connection);
          return finish(
            {
              profile: connection.credentials.profile,
              previous: s.account,
              access: config.access,
            },
            s,
          );
        }
        const profile = randomUUID(),
          s = await pool.get(profile);
        let uri;
        try {
          const r = await s.bridge.call("startLink");
          uri = r?.deviceLinkUri;
          if (
            typeof uri !== "string" ||
            !uri.startsWith("sgnl://linkdevice?") ||
            uri.length > 4096
          )
            throw fail("pairing_failed", 502);
        } catch (e) {
          await pool.drop(profile);
          throw e;
        }
        const id = randomUUID(),
          f = {
            profile,
            previous: connection?.credentials.account,
            oldProfile: connection?.credentials.profile,
            access: config.access,
            expires: Date.now() + 150000,
            done: false,
            error: null,
          };
        pending.set(id, f);
        f.completion = s.bridge
          .call(
            "finishLink",
            { deviceLinkUri: uri, deviceName: "Switchboard" },
            150000,
          )
          .then(
            (a) => {
              f.account = a;
              f.done = true;
            },
            (e) => {
              f.error = e;
            },
          );
        return {
          device: {
            qrCode: uri,
            instructions:
              "On your phone, open Signal → Settings → Linked devices → Link new device and scan this code.",
            expiresIn: 150,
            interval: 3,
          },
          pending: { id },
        };
      },
      async poll({ pending: state }) {
        const f = pending.get(state?.id);
        if (!f || f.expires < Date.now()) throw fail("pairing_expired", 401);
        if (f.error) {
          pending.delete(state.id);
          await pool.drop(f.profile);
          throw fail("pairing_failed", 502);
        }
        if (!f.done) return { wait: true };
        pending.delete(state.id);
        try {
          const s = await pool.activate(await pool.get(f.profile), f.account);
          return await finish(f, s);
        } catch (e) {
          await pool.drop(f.profile);
          throw e;
        }
      },
      async revoke(conn) {
        for (const [id, f] of pending)
          if (f.profile === conn.credentials.profile) pending.delete(id);
        await pool.drop(conn.credentials.profile);
      },
    },
    async ready(conn) {
      return pool.session(conn);
    },
    dispose() {
      clearInterval(timer);
      pending.clear();
    },
  };
}
