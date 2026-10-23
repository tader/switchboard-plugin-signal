import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fail } from "./errors.js";

// The lock inode survives profile deletion. Never unlink it: another process
// may already have opened that inode while waiting to acquire ownership.
export async function acquireSessionLock(ctx, id) {
  if (!["darwin", "linux"].includes(process.platform))
    throw fail("unsupported_platform", 503);
  const root = path.join(ctx.dataDir, "locks");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const handle = await fs.open(path.join(root, id + ".lock"), "a+", 0o600);
  try {
    await handle.chmod(0o600);
    await new Promise((resolve, reject) => {
      // Both commands lock the inherited open file description. The lock stays
      // held by our handle after the command exits, without a lock-server PID.
      const child = spawn(
        process.platform === "darwin" ? "/usr/bin/lockf" : "flock",
        process.platform === "darwin"
          ? ["-s", "-t", "0", "3"]
          : ["--nonblock", "--conflict-exit-code", "75", "3"],
        { stdio: ["ignore", "ignore", "ignore", handle.fd] },
      );
      child.once("error", () => reject(fail("session_lock_unavailable", 503)));
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else
          reject(
            fail(
              code === 75 ? "session_in_use" : "session_lock_unavailable",
              code === 75 ? 409 : 503,
            ),
          );
      });
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Older plugin versions used only a PID marker. Respect a live legacy owner
// during migration. A marker predating this process cannot belong to this PID
// incarnation, which matters when containers restart with the same PID.
export async function checkLegacyOwner(dir) {
  const marker = path.join(dir, "owner.json");
  let owner, stat;
  try {
    owner = JSON.parse(await fs.readFile(marker, "utf8"));
    stat = await fs.stat(marker);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
  if (owner?.lockVersion === 2) return;
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return;
  if (
    owner.pid === process.pid &&
    stat.mtimeMs < Date.now() - process.uptime() * 1000 - 1000
  )
    return;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
  }
  throw fail("session_in_use", 409);
}
