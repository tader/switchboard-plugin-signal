import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// This selector must run from the protected-main workflow checkout. Candidate
// commits supply JSON metadata only; none of their code runs during selection.
export function selectRelease({ repo, workflowSha, ref, recoveryCommit = "" }, api) {
  if (ref !== "refs/heads/main")
    throw Error("Release selection must run from protected main");
  const commit = recoveryCommit || workflowSha;
  if (!repo || !/^[a-f0-9]{40}$/.test(commit ?? ""))
    throw Error("Expected an immutable release commit");
  const skip = { commit, publish: false, reconcile: false, version: "", pr: "" };
  const associated = api(`repos/${repo}/commits/${commit}/pulls`);
  const candidates = associated.filter(p =>
    p.merged_at && p.merge_commit_sha === commit &&
    p.base.ref === "main" && p.base.repo.full_name === repo &&
    p.head.ref.startsWith("release-please--branches--main"),
  );
  if (!candidates.length) {
    if (recoveryCommit) throw Error("Recovery requires an exact merged version-PR commit");
    return skip;
  }
  const file = api(`repos/${repo}/contents/package.json?ref=${commit}`);
  if (file?.encoding !== "base64") throw Error("Expected package JSON metadata");
  const { version } = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw Error("Invalid release version");
  const pr = candidates.find(p => p.title.endsWith(" " + version));
  if (!pr || version === "0.0.0") {
    if (recoveryCommit) throw Error("Recovery version does not match its merged version PR");
    return skip;
  }
  const release = api(`repos/${repo}/releases/tags/v${version}`);
  const published = release !== null && !release.draft;
  return { commit, publish: !published, reconcile: published, version, pr: pr.number };
}

function api(endpoint) {
  try {
    return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8" }));
  } catch (error) {
    // Only an explicit missing resource is absence; permission/network errors
    // must not enable publication.
    let missing = false;
    try { missing = String(JSON.parse(error.stdout).status) === "404"; } catch {}
    if (missing) return null;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = selectRelease({
    repo: process.env.GH_REPO,
    workflowSha: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    recoveryCommit: process.env.RELEASE_COMMIT,
  }, api);
  for (const [key, value] of Object.entries(plan)) console.log(`${key}=${value}`);
}
