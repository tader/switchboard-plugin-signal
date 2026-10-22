import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const script = path.resolve("scripts/release.js"),
  sha = "a".repeat(40);
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-release-")),
    bin = path.join(dir, "bin"),
    state = path.join(dir, "state.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, ".local/release"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  fs.writeFileSync(
    state,
    JSON.stringify({
      calls: [],
      exists: false,
      draft: true,
      tagExists: false,
      sha,
      reviewed: true,
      ...overrides,
    }),
  );
  fs.writeFileSync(
    path.join(bin, "gh"),
    "#!/usr/bin/env node\n" +
      String.raw`
const fs=require("node:fs"),args=process.argv.slice(2),file=process.env.GH_FIXTURE,s=JSON.parse(fs.readFileSync(file));
s.calls.push(args);let out="",exit=0;
if(args[0]==="api"&&args[1].includes("/commits/"))out=JSON.stringify(s.reviewed?[{number:7,merged_at:"2026-10-22",merge_commit_sha:process.env.GITHUB_SHA,base:{ref:"main"},head:{ref:"release-please--branches--main--components--signal"},title:"chore(main): release 1.0.0"}]:[]);
else if(args[0]==="api"&&args[1].endsWith("/git/refs")) {
 if(s.tagExists){exit=1;out=JSON.stringify({status:"422"});}
 else{s.tagExists=true;s.sha=args.find(a=>a.startsWith("sha=")).slice(4);out=JSON.stringify({object:{type:"commit",sha:s.sha}});}
}
else if(args[0]==="api"&&args[1].includes("/git/ref/tags/")){
 if(s.tagReadError){exit=1;out=JSON.stringify({status:String(s.tagReadError)});}
 else if(!s.tagExists){exit=1;out=JSON.stringify({status:"404"});}
 else out=JSON.stringify({object:{type:"commit",sha:s.sha}});
}
else if(args[0]==="api")out=JSON.stringify({object:{type:"commit",sha:s.sha}});
else if(args[0]==="release"&&args[1]==="view"){if(!s.exists)exit=1;else out=JSON.stringify({isDraft:s.draft});}
else if(args[0]==="release"&&args[1]==="create"){s.exists=true;s.draft=true;}
else if(args[0]==="release"&&args[1]==="edit")s.draft=false;
else if(args[0]==="label"&&s.failLabel){s.failLabel=false;exit=1;}
fs.writeFileSync(file,JSON.stringify(s));process.stdout.write(out);process.exit(exit);
`.slice(1),
    { mode: 0o700 },
  );
  const assets = [
    "signal-runtime-linux-amd64.tar.gz",
    "signal-runtime-linux-arm64.tar.gz",
    "signal-runtime-darwin-amd64.tar.gz",
    "signal-runtime-darwin-arm64.tar.gz",
    "corresponding-sources.tar.gz",
  ];
  for (const name of assets)
    fs.writeFileSync(
      path.join(dir, ".local/release", name),
      "fixture artifact",
    );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    state,
    run: (mode) =>
      spawnSync(process.execPath, [script, mode], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          GH_FIXTURE: state,
          GH_REPO: "fixture/signal",
          GITHUB_SHA: sha,
          RELEASE_PR: "7",
        },
      }),
    read: () => JSON.parse(fs.readFileSync(state)),
  };
}
test("publisher gates on reviewed version and complete assets, then uploads before publishing", (t) => {
  const f = fixture(t);
  assert.match(f.run("plan").stdout, /publish=true/);
  const r = f.run("publish");
  assert.equal(r.status, 0, r.stderr);
  const s = f.read();
  assert.equal(s.draft, false);
  const upload = s.calls.findIndex(
      (a) => a[0] === "release" && a[1] === "upload",
    ),
    publish = s.calls.findIndex((a) => a[0] === "release" && a[1] === "edit");
  assert(upload < publish);
  assert.equal(s.calls[upload].filter((a) => a.endsWith(".tar.gz")).length, 5);
  assert.equal(
    fs
      .readFileSync(path.join(f.dir, ".local/release/sha256sums.txt"), "utf8")
      .trim()
      .split("\n").length,
    5,
  );
  assert.match(f.run("plan").stdout, /publish=false/);
  assert.notEqual(f.run("publish").status, 0);
});
test("publisher refuses missing assets and moved tags without uploading", (t) => {
  const f = fixture(t, { exists: true, tagExists: true, sha: "b".repeat(40) });
  assert.notEqual(f.run("publish").status, 0);
  assert(!f.read().calls.some((a) => a[1] === "upload"));
  fs.unlinkSync(
    path.join(f.dir, ".local/release/signal-runtime-linux-arm64.tar.gz"),
  );
  assert.notEqual(f.run("publish").status, 0);
  assert(!f.read().calls.some((a) => a[1] === "upload"));
});
test("post-publication labeling failure can be repaired without overwriting a release", (t) => {
  const f = fixture(t, { failLabel: true });
  assert.notEqual(f.run("publish").status, 0);
  assert.equal(f.read().draft, false);
  assert.match(f.run("plan").stdout, /reconcile=true/);
  const r = f.run("reconcile");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read().calls.filter((a) => a[1] === "upload").length, 1);
});
test("ordinary main commits cannot publish", (t) => {
  const f = fixture(t, { reviewed: false });
  assert.match(f.run("plan").stdout, /publish=false/);
  assert.notEqual(f.run("publish").status, 0);
  assert(!f.read().calls.some((a) => a[1] === "create"));
});

test("publisher recovers a tagless draft by creating the exact reviewed tag before upload", t => {
  const f = fixture(t, { exists: true });
  const result = f.run("publish");
  assert.equal(result.status, 0, result.stderr);
  const state = f.read();
  const create = state.calls.findIndex(args => args[0] === "api" && args[1].endsWith("/git/refs"));
  const upload = state.calls.findIndex(args => args[0] === "release" && args[1] === "upload");
  assert.ok(create >= 0 && create < upload);
  assert.ok(state.calls[create].includes("ref=refs/tags/v1.0.0"));
  assert.ok(state.calls[create].includes("sha=" + sha));
  assert.equal(state.draft, false);
  assert.equal(state.calls.filter(args => args[0] === "release" && args[1] === "create").length, 0);
});

test("publisher reuses correct existing tags and never treats a permission failure as a missing tag", t => {
  const existing = fixture(t, { exists: true, tagExists: true });
  assert.equal(existing.run("publish").status, 0);
  assert.ok(!existing.read().calls.some(args => args[0] === "api" && args[1].endsWith("/git/refs")));
  const forbidden = fixture(t, { exists: true, tagReadError: 403 });
  assert.notEqual(forbidden.run("publish").status, 0);
  assert.ok(!forbidden.read().calls.some(args => args[1] === "upload" || args[1]?.endsWith("/git/refs")));
});
