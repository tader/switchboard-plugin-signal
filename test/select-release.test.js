import test from "node:test";
import assert from "node:assert/strict";
import { selectRelease } from "../scripts/select-release.js";

const commit = "fc9d48b515ca94b898eaf09e98dfa225aeea3bdb";
const repo = "tader/switchboard-plugin-signal";
const options = {
  repo, workflowSha: "a".repeat(40), ref: "refs/heads/main", recoveryCommit: commit,
};
function fixture(overrides = {}) {
  const calls = [];
  const pr = {
    number: 19, merged_at: "2026-11-27T10:33:05Z", merge_commit_sha: commit,
    base: { ref: "main", repo: { full_name: repo } },
    head: { ref: "release-please--branches--main--components--signal" },
    title: "chore(main): release 1.4.0",
    ...overrides.pr,
  };
  return {
    calls,
    api(endpoint) {
      calls.push(endpoint);
      if (endpoint.endsWith("/pulls")) return overrides.prs ?? [pr];
      if (endpoint.includes("/contents/package.json?ref=")) return {
        encoding: "base64",
        content: Buffer.from(JSON.stringify({ version: overrides.version ?? "1.4.0" })).toString("base64"),
      };
      if (endpoint.endsWith("/releases/tags/v1.4.0")) return overrides.release ?? null;
      throw Error("Unexpected API call: " + endpoint);
    },
  };
}

test("trusted selector accepts the exact version PR merge and binds metadata to that SHA", () => {
  const f = fixture();
  assert.deepEqual(selectRelease(options, f.api), {
    commit, publish: true, reconcile: false, version: "1.4.0", pr: 19,
  });
  assert.deepEqual(f.calls, [
    `repos/${repo}/commits/${commit}/pulls`,
    `repos/${repo}/contents/package.json?ref=${commit}`,
    `repos/${repo}/releases/tags/v1.4.0`,
  ]);
});

test("ordinary recovery commits fail before even reading candidate package metadata", () => {
  const f = fixture({ prs: [] });
  assert.throws(() => selectRelease(options, f.api), /exact merged version-PR/);
  assert.equal(f.calls.length, 1);
  // An ordinary main push remains a no-op rather than a failed recovery.
  assert.equal(selectRelease({ ...options, recoveryCommit: "" }, f.api).publish, false);
});

test("associated PRs cannot authorize a different merge, unmerged PR or other release destination", () => {
  for (const pr of [
    { merge_commit_sha: "b".repeat(40) }, { merged_at: null },
    { head: { ref: "feature/ordinary" } },
    { base: { ref: "other", repo: { full_name: repo } } },
    { base: { ref: "main", repo: { full_name: "other/repo" } } },
  ]) {
    const f = fixture({ pr });
    assert.throws(() => selectRelease(options, f.api), /exact merged version-PR/);
    assert.equal(f.calls.length, 1);
  }
});

test("mismatching and output-injecting versions never produce a publication plan", () => {
  for (const version of ["1.3.0", "0.0.0", "1.4.0\npublish=true"]) {
    const f = fixture({ version });
    assert.throws(() => selectRelease(options, f.api), /version/i);
    assert.equal(f.calls.length, 2);
  }
});

test("branch inputs and workflows outside protected main fail before API access", () => {
  for (const override of [
    { recoveryCommit: "main" }, { recoveryCommit: "$(echo unsafe)" },
    { ref: "refs/heads/unreviewed" },
  ]) {
    const f = fixture();
    assert.throws(() => selectRelease({ ...options, ...override }, f.api));
    assert.deepEqual(f.calls, []);
  }
});

test("published releases select reconciliation while drafts remain recoverable", () => {
  assert.equal(selectRelease(options, fixture({ release: { draft: true } }).api).publish, true);
  const plan = selectRelease(options, fixture({ release: { draft: false } }).api);
  assert.equal(plan.publish, false);
  assert.equal(plan.reconcile, true);
});

test("GitHub permission or transport failures cannot enable downstream jobs", () => {
  assert.throws(() => selectRelease(options, () => { throw Error("HTTP 403"); }), /403/);
});
