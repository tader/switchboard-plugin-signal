#!/usr/bin/env node
// Offline protocol fixture. No Signal credentials or external network access.
const fs = require("node:fs"),
  path = require("node:path"),
  rl = require("node:readline");
const dir = process.argv[process.argv.indexOf("--config") + 1],
  account =
    process.env.SIGNAL_FIXTURE_ACCOUNT ??
    "11111111-1111-4111-8111-111111111111";
const peer = "22222222-2222-4222-8222-222222222222",
  group = Buffer.from("fixture-group-identifier").toString("base64");
const marker = path.join(dir, "fixture.json"),
  trace = path.join(dir, "fixture-trace.jsonl");
const out = (x) => process.stdout.write(JSON.stringify(x) + "\n");
const notify = (data) =>
  out({
    jsonrpc: "2.0",
    method: "receive",
    params: {
      subscription: 0,
      result: {
        account,
        envelope: {
          sourceUuid: peer,
          sourceName: "Fixture",
          timestamp: data.timestamp,
          dataMessage: data,
        },
      },
    },
  });
rl.createInterface({ input: process.stdin }).on("line", (line) => {
  const r = JSON.parse(line),
    q = r.params ?? {};
  fs.appendFileSync(
    trace,
    JSON.stringify({ method: r.method, params: q }) + "\n",
  );
  let result;
  if (r.method === "listAccounts")
    result = fs.existsSync(marker) ? [{ aci: account, number: null }] : [];
  else if (r.method === "startLink")
    result = {
      deviceLinkUri: "sgnl://linkdevice?uuid=fixture&pub_key=fixture",
    };
  else if (r.method === "finishLink") {
    setTimeout(() => {
      fs.writeFileSync(marker, "{}");
      out({ jsonrpc: "2.0", id: r.id, result: { aci: account, number: null } });
    }, 10);
    return;
  } else if (r.method === "subscribeReceive") {
    result = 0;
    setTimeout(() => {
      notify({ timestamp: 1000, message: "Fixture text", expiresInSeconds: 0 });
      notify({
        timestamp: 2000,
        pollCreate: {
          question: "Choose",
          options: ["One", "Two"],
          allowMultiple: false,
        },
        expiresInSeconds: 0,
      });
      notify({
        timestamp: 3000,
        message: "DO-NOT-ARCHIVE",
        expiresInSeconds: 60,
      });
      notify({
        timestamp: 4000,
        message: "Group text",
        groupInfo: { groupId: group },
        expiresInSeconds: 0,
      });
    }, 5);
  } else if (r.method === "listContacts")
    result = [{ uuid: peer, name: "Fixture" }];
  else if (r.method === "listGroups")
    result = [{ id: group, name: "Fixture group" }];
  else if (["send", "sendReaction", "sendPollVote"].includes(r.method)) {
    if (q.message === "uncertain") {
      process.exit(0);
      return;
    }
    if (q.message === "identity-change") {
      out({
        jsonrpc: "2.0",
        id: r.id,
        error: { code: -1, message: "Untrusted identity" },
      });
      return;
    }
    result = {
      timestamp: Date.now(),
      results: [{ recipientAddress: { uuid: peer }, type: "SUCCESS" }],
    };
  } else {
    out({
      jsonrpc: "2.0",
      id: r.id,
      error: { code: -32601, message: "Unsupported fixture method" },
    });
    return;
  }
  out({ jsonrpc: "2.0", id: r.id, result });
});
