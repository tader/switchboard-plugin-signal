import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
const repo = process.env.GH_REPO,
  sha = process.env.GITHUB_SHA,
  version = JSON.parse(fs.readFileSync("package.json")).version,
  tag = "v" + version;
if (!repo || !/^[a-f0-9]{40}$/.test(sha ?? ""))
  throw Error("Run from the publishing workflow at an immutable commit");
const associated = JSON.parse(
  gh(["api", "repos/" + repo + "/commits/" + sha + "/pulls"]),
);
const pr = associated.find(
  (p) =>
    p.merged_at &&
    p.merge_commit_sha === sha &&
    p.base.ref === "main" &&
    p.head.ref.startsWith("release-please--branches--main") &&
    p.title.endsWith(" " + version),
);
const found = spawnSync("gh", ["release", "view", tag, "--json", "isDraft"], {
  encoding: "utf8",
});
const published = found.status === 0 && !JSON.parse(found.stdout).isDraft;
function markTagged() {
  gh([
    "label",
    "create",
    "autorelease: tagged",
    "--color",
    "1D76DB",
    "--description",
    "Release has been published",
    "--force",
  ]);
  gh([
    "pr",
    "edit",
    String(pr.number),
    "--add-label",
    "autorelease: tagged",
    "--remove-label",
    "autorelease: pending",
  ]);
}
if (process.argv[2] === "plan") {
  console.log("publish=" + (!!pr && version !== "0.0.0" && !published));
  console.log("reconcile=" + (!!pr && published));
  console.log("version=" + version);
  console.log("pr=" + (pr?.number ?? ""));
} else if (process.argv[2] === "reconcile") {
  if (!pr || !published) throw Error("Expected a published reviewed release");
  markTagged();
} else {
  if (process.argv[2] !== "publish") throw Error("Unknown release command");
  if (!pr || published || String(pr.number) !== process.env.RELEASE_PR)
    throw Error("Expected an unpublished reviewed release PR");
  const root = ".local/release",
    files = [
      "signal-runtime-linux-amd64.tar.gz",
      "signal-runtime-linux-arm64.tar.gz",
      "signal-runtime-darwin-amd64.tar.gz",
      "signal-runtime-darwin-arm64.tar.gz",
      "corresponding-sources.tar.gz",
    ];
  for (const file of files)
    if (!fs.statSync(path.join(root, file)).size)
      throw Error("Missing release asset");
  const sums =
    files
      .map(
        (f) =>
          createHash("sha256")
            .update(fs.readFileSync(path.join(root, f)))
            .digest("hex") +
          "  " +
          f,
      )
      .join("\n") + "\n";
  fs.writeFileSync(path.join(root, "sha256sums.txt"), sums);
  if (found.status !== 0)
    gh([
      "release",
      "create",
      tag,
      "--target",
      sha,
      "--draft",
      "--title",
      "Signal " + tag,
      "--generate-notes",
    ]);
  const tagPath = "repos/" + repo + "/git/ref/tags/" + tag;
  const lookup = spawnSync("gh", ["api", tagPath], { encoding: "utf8" });
  let ref;
  if (lookup.status === 0) {
    ref = JSON.parse(lookup.stdout).object;
  } else {
    let missing = false;
    try { missing = String(JSON.parse(lookup.stdout).status) === "404"; } catch {}
    if (!missing) throw Error("Unable to verify the release tag");
    // A draft release does not create its target tag. Create it explicitly at
    // the reviewed immutable release commit; never move an existing tag.
    ref = JSON.parse(gh([
      "api", "repos/" + repo + "/git/refs", "--method", "POST",
      "-f", "ref=refs/tags/" + tag, "-f", "sha=" + sha,
    ])).object;
  }
  let commit = ref;
  if (ref.type === "tag")
    commit = JSON.parse(
      gh(["api", "repos/" + repo + "/git/tags/" + ref.sha]),
    ).object;
  if (commit.sha !== sha)
    throw Error("Existing release tag points to another commit");
  gh([
    "release",
    "upload",
    tag,
    ...[...files, "sha256sums.txt"].map((f) => path.join(root, f)),
    "--clobber",
  ]);
  gh(["release", "edit", tag, "--draft=false", "--latest"]);
  markTagged();
  console.log("Published " + tag);
}
