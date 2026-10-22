import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fail } from "./errors.js";
const exec = promisify(execFile);
const inflight = new Map();
export function platformKey(
  platform = process.platform,
  arch = process.arch,
  glibc = process.report?.getReport().header.glibcVersionRuntime,
) {
  if (
    !["darwin", "linux"].includes(platform) ||
    !["x64", "arm64"].includes(arch) ||
    (platform === "linux" && !glibc)
  )
    throw fail("unsupported_platform", 503);
  return platform + "-" + (arch === "x64" ? "amd64" : arch);
}
export function checksumFor(sums, name) {
  const lines = sums.trim().split(/\r?\n/);
  const matches = lines
    .map((line) => /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line))
    .filter((m) => m?.[2] === name);
  if (matches.length !== 1) throw fail("helper_checksum_mismatch", 502);
  return matches[0][1];
}
async function download(url, file, max, expected) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok || !r.body) throw fail("helper_release_unavailable", 503);
  const handle = await fs.open(file, "wx", 0o600),
    hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > max) throw fail("helper_download_failed", 502);
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
  } finally {
    await handle.close();
  }
  if (hash.digest("hex") !== expected)
    throw fail("helper_checksum_mismatch", 502);
}
export async function ensureRuntime(ctx) {
  if (ctx.settings.signalCliPath) {
    const executable = ctx.settings.signalCliPath;
    if (!path.isAbsolute(executable)) throw fail("invalid_helper_path", 503);
    await fs.access(executable, fs.constants.X_OK);
    return { executable, prefix: [] };
  }
  const version = ctx.manifest.version;
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    throw fail("invalid_version", 503);
  const key = platformKey(),
    root = path.join(ctx.dataDir, "runtimes", version, key);
  const launch = () => ({
    executable: path.join(root, "runtime/jre/bin/java"),
    prefix: [
      "--enable-native-access=ALL-UNNAMED",
      "-cp",
      path.join(root, "runtime/signal-cli/lib/*"),
      "org.asamk.signal.Main",
    ],
  });
  try {
    await fs.access(path.join(root, ".verified"));
    return launch();
  } catch {}
  const lock = root;
  if (!inflight.has(lock))
    inflight.set(
      lock,
      (async () => {
        await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
        const tmp = root + "." + randomUUID();
        await fs.mkdir(tmp, { mode: 0o700 });
        try {
          const base =
            "https://github.com/tader/switchboard-plugin-signal/releases/download/v" +
            version +
            "/";
          const response = await fetch(base + "sha256sums.txt", {
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) throw fail("helper_release_unavailable", 503);
          const sums = await response.text();
          if (sums.length > 65536) throw fail("helper_checksum_mismatch", 502);
          const name = "signal-runtime-" + key + ".tar.gz",
            archive = path.join(tmp, "bundle.tgz");
          await download(
            base + name,
            archive,
            400 * 1024 * 1024,
            checksumFor(sums, name),
          );
          const { stdout: names } = await exec("tar", ["-tzf", archive], {
            maxBuffer: 8 * 1024 * 1024,
          });
          const { stdout: types } = await exec("tar", ["-tvzf", archive], {
            maxBuffer: 8 * 1024 * 1024,
          });
          if (
            names
              .split("\n")
              .filter(Boolean)
              .some(
                (n) =>
                  !/^runtime(?:\/|$)/.test(n) || n.split("/").includes(".."),
              ) ||
            types
              .split("\n")
              .filter(Boolean)
              .some((n) => !["-", "d"].includes(n[0]))
          )
            throw fail("invalid_runtime_archive", 502);
          await exec("tar", ["-xzf", archive, "-C", tmp]);
          await fs.unlink(archive);
          await fs.access(
            path.join(tmp, "runtime/jre/bin/java"),
            fs.constants.X_OK,
          );
          await fs.writeFile(path.join(tmp, ".verified"), version + "\n", {
            mode: 0o600,
          });
          await fs.rename(tmp, root);
        } finally {
          await fs.rm(tmp, { recursive: true, force: true });
        }
      })().finally(() => inflight.delete(lock)),
    );
  await inflight.get(lock);
  return launch();
}
