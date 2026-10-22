---
title: Connecting Signal
services: [signal]
order: 1
---

# Connecting Signal

Add a Signal connection and select read-only or read/write access. The first connection downloads verified helper files and a private Java runtime; no system Java installation is needed.

On your phone, open **Signal → Settings → Linked devices → Link new device** and scan Switchboard's QR code. Keep the dialog open until linking completes. Codes expire after 150 seconds. Close and restart an expired or cancelled flow. Existing numbered and numberless accounts are supported.

The owner needs Node 24+, `tar`, outbound access to GitHub releases and Signal, and write access to plugin data. Supported hosts are macOS Intel/Apple Silicon and glibc Linux x64/ARM64, including Switchboard's Debian Docker image.

## Recovery

- **Upgrade requirement:** update Switchboard to a release with QR device authorization.
- **Revoked device:** reconnect, expand Advanced, and choose **Link a replacement device**. The original account must approve replacement. Cached history and write receipts are preserved.
- **Wrong account:** link the original account, or create a separate connection.
- **Unavailable runtime:** stable installations need a matching published release. A development installation can use an absolute local signal-cli executable.
- **Checksum failure:** no downloaded program is executed. Retry after checking that the release assets are complete.
- **Session in use:** stop the other instance. Never copy a live profile between running instances.
- **Changed safety number:** verify the contact and use signal-cli's normal identity-management procedures. Changed keys are never automatically trusted.
- **Uncertain delivery:** inspect the original idempotency key with `getSignalWriteStatus` and check Signal before sending again.

Keys and caches are service-user-owned local files with private permissions. They have no additional plugin password encryption. Include plugin data in your normal encrypted backups and disk-protection policy.

Delete the connection and remove the linked device on your phone to disconnect completely.

## Development wrapper

Build the private runtime with `npm run build:runtime`, then configure an executable wrapper with absolute paths:

```sh
#!/bin/sh
exec /absolute/plugin/.local/runtime/runtime/jre/bin/java \
  --enable-native-access=ALL-UNNAMED \
  -cp '/absolute/plugin/.local/runtime/runtime/signal-cli/lib/*' \
  org.asamk.signal.Main "$@"
```

Set its absolute path as **Signal CLI executable**. It must accept standard signal-cli arguments.

## Peer access

Pair on the owner and use **Peers → Share connection**. Remote requests use the owner's linked device and access level. Session files and caches stay on the owner. Offline owners and revoked shares are unavailable.
