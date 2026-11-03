---
title: Shared Messaging contract (staged)
services: [signal]
---

# Shared Messaging contract

This adds the optional generic Messaging v1 contract beside Signal's existing API.
It depends on [Switchboard #40](https://github.com/tader/switchboard/pull/40), whose
contract API remains disabled by default. The canonical JSON schema is vendored
from the core. Existing authentication methods, session restoration and APIs remain
available on older cores.

Implemented operations are conversation list/get, message list/get, message send
with optional cached reply target, and reaction update. Read-only bindings expose
only the four reads. Conversation creation, edits, deletion, threads and read-state
updates are absent. Reads never send read receipts. Only exact targets in the
owner-local synced cache are accepted; the contract does not invent recipients.

History always reports `coverage.complete: false` / `synced_cache_only`. There is
no history backfill. Unknown unread/reaction totals stay null. Restricted, deleted
and unavailable content has null text. Disappearing/view-once bodies are not
archived, published or quoted by the adapter. Outgoing write text is not cached;
provider receive/sync establishes whether a body can be retained. Send constraints
are advertised separately from the common schema; the existing 4000 UTF-16-unit
limit remains in force. Oversized input is rejected without sending.

## Native cache-change feed

The owner-local cache records a metadata-only change sequence in the same SQLite
transaction as each observable mutation. Duplicate ordinary deliveries do not append
another change. Events invalidate the messaging snapshot and never include message
text, authors or attachment contents. The native watch loop replays from a durable
opaque checkpoint, waits on receive callbacks, and awaits the core publication
commit before advancing its local delivery cursor. It releases its wait listener
when the core cancels it after inactivity, access/config changes or shutdown.
Linked-device helper lifecycle follows the existing owner-local Pool behavior.

A missing, foreign or evicted checkpoint yields `resync.required`. Retention is at
most seven days / 100000 metadata records, with atomic eviction watermark updates.
This feed covers changes observed by the local cache. Signal CLI owns upstream
receive acknowledgements; this does not promise end-to-end exactly-once delivery
from Signal or complete provider history. Core SSE is resumable and at least once.

Writes reuse a connection-namespaced form of the core intent key in Signal's existing
persistent ledger. An uncertain dispatch is not resent. No new device pairing,
provider consent or live test messages are performed by enabling these definitions.

## Validation

`npm run check`, `npm test`, `integration`, `integration:peers` and
`integration:contracts` use offline fixtures. The last script needs a core with
shared contracts and enables `SWITCHBOARD_SHARED_CONTRACTS=1` only in its temporary
fixture instance. CI retains legacy-core compatibility checks and separately pins
the staged core revision for the new HTTP/SSE integration.

`npm run build:runtime` and `npm run test:runtime` verify the checksum-pinned native
runtime on the current platform. CI additionally builds/tests all supported runtime
platforms. All accounts and messages used in these checks are offline fixtures.
