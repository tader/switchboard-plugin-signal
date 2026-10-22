# Signal plugin for Switchboard

Signal direct/group chats for [Switchboard](https://github.com/tader/switchboard): read received/synced messages, send text, quote cached messages, add/remove reactions, and vote in existing polls.

The plugin manages an unofficial [signal-cli](https://github.com/AsamK/signal-cli) linked device. A private Java runtime and verified helper files are downloaded automatically; system Java installation and a separate daemon are unnecessary.

## Install and link

Install **tader/switchboard-plugin-signal**, folder **plugins/signal**, through **Plugins → Install from GitHub**. Stable installation requires a published release.

Use a Switchboard release containing QR authorization (core commit `8a09c51d833ced905290eda600feb6ca93c599f6` or newer). Older cores show an upgrade requirement.

Add a Signal connection, choose read-only or read/write access, and continue. On your phone, open **Signal → Settings → Linked devices → Link new device**, then scan the QR code. Codes expire after 150 seconds. Both numbered and numberless existing accounts are supported; linking never replaces your primary phone.

Supported hosts: macOS Intel/Apple Silicon and glibc Linux x64/ARM64, including Switchboard's Debian Bookworm Docker image. Node 24+ and `tar` are required. Alpine/musl and Windows are outside this release. The runtime stays in plugin data, separately from system Java.

See [setup and recovery](plugins/signal/docs/setup.md) and [operation examples](plugins/signal/docs/operations.md).

## Operations

| Operation               | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `getSignalStatus`       | Local helper/session state and cache coverage       |
| `getSignalCapabilities` | Features and selected access level                  |
| `listSignalChats`       | Paginated known direct/group chats                  |
| `listSignalMessages`    | Paginated received/synced messages                  |
| `getSignalMessage`      | Cached message, quote metadata or poll options      |
| `sendSignalMessage`     | Text, optionally quoting a cached message           |
| `reactSignalMessage`    | Add/change a reaction; empty emoji removes it       |
| `voteSignalPoll`        | Replace selected options; empty selection withdraws |
| `getSignalWriteStatus`  | Durable receipts without resending                  |

History reports `coverage=synced_cache_only`. It contains only events this device received and sent-message transcripts supplied by Signal. There is no full server archive, Signal Desktop database import, or older-history request. Write request bodies are not inserted into history: a provider event must establish their privacy status first.

Disappearing and view-once bodies are not archived. Received remote/administrator deletions remove cached bodies and leave tombstones so late synchronization cannot restore them. Media exposes metadata/type only. Attachment transfer, edits, calls, poll creation/results, and group administration are outside this version.

The plugin never automatically sends read receipts or typing indicators. Signal's normal transport delivery acknowledgments still occur. Identity trust follows signal-cli's default first-use policy; changed identities are never automatically trusted.

## Reliable writes

Every write requires an `idempotencyKey`. Repeating identical accepted content returns its saved receipt, including after restarts or replacement-device linking. Different content with the same key fails. A helper exit, timeout, partial failure or invalid receipt after a write starts leaves durable state `attempted`: delivery is uncertain and the plugin does not resend.

Inspect `/writes` and check Signal on your phone before deciding to send again. A new key denotes a new intentional write, not recovery for uncertain delivery. Signal offers no general lookup that can resolve every uncertain send.

Poll votes resolve exact cached option text to indexes and persist increasing vote counters. Missing, ambiguous, restricted, closed or uncached targets fail before sending. Removing a reaction requires its cached original emoji.

## Local and remote use

Pair on the connection owner. **Peers → Share connection** provides remote access; calls execute on the owner. Keys, caches and helper files stay there. Sessions are not exportable authentication sources and cannot be opened by multiple concurrent instances.

Deleting a connection removes its local profile. Also remove the device from your phone's Linked devices screen to revoke it at Signal.

## Development

```sh
npm ci
npm run check
npm test
SWITCHBOARD_ROOT=/path/to/switchboard npm run integration
SWITCHBOARD_ROOT=/path/to/switchboard npm run integration:peers
npm run build:runtime
npm run test:runtime
```

Before the first release, configure an absolute compatible signal-cli executable in plugin settings. The setup guide shows a wrapper for the development private JRE.

Runtime inputs are pinned with SHA-256 in `runtime-pins.json`. Linux ARM64 JNI is built against Debian Bookworm. Runtime tests load real JNI and start real JSON-RPC with an empty local store; protocol, installer and peer tests use a fixture account. Live phone pairing and delivery need separate manual verification and are not claimed by offline suites.

## Releases

Release Please updates the package, lockfile, plugin version and changelog in reviewed PRs. Its workflow explicitly dispatches required CI on release PR heads with `GITHUB_TOKEN`.

Merging a release PR starts publication: four tested runtime bundles and corresponding sources are uploaded to a draft, its tag is checked against the reviewed commit, and publication waits for all assets. Failed runs can be rerun at their original commit; completed releases are not overwritten. The publisher marks the release PR tagged afterward.

GitHub Actions settings must allow creating pull requests. GitHub combines that setting with permission to approve PRs; these workflows do not submit approving reviews. Main requires PRs and passing CI, including for administrators, with zero mandatory approving reviews.

Downloads use the installed plugin's exact version and matching checksums. [Notices](NOTICE.md) and corresponding sources accompany runtime releases.
