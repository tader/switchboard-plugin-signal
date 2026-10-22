# Signal plugin development

The self-contained Node 24 plugin lives in plugins/signal. Only type imports may reference the snapshotted core API. Runtime modules use Node built-ins; do not add plugin-local node_modules.

Run npm run check, npm test, and both integration scripts against SWITCHBOARD_ROOT. Run npm run test:runtime after building the current platform runtime. CI verifies macOS/Linux on x64/ARM64, including Debian container JNI startup.

Keep package.json, package-lock.json and plugin.json versions synchronized through Release Please. Pin runtime inputs with SHA-256 in runtime-pins.json. Never download an unverified latest executable. Retain third-party notices and corresponding sources.

Preserve read-only enforcement, owner-local sessions, no automatic read receipts, no archived disappearing/view-once bodies, exact cached targets, durable write idempotency and no resend of uncertain writes. Tests use offline fixture accounts, never live credentials.

Use Siding for managed branch/worktree operations. Main requires PRs and passing check status; do not bypass protection.
