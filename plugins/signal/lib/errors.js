export class SignalError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(
      {
        signin_required: "Reconnect Signal to restore this linked device.",
        helper_starting:
          "Signal is preparing its runtime and restoring your linked device. Wait a moment and retry. No message was sent.",
        session_in_use:
          "Another process is using this Signal session. Stop the other Switchboard instance or Signal helper before retrying. No message was sent.",
        session_lock_unavailable:
          "Signal could not acquire a system session lock. Linux hosts need flock from util-linux; macOS hosts need the built-in lockf utility.",
        pairing_expired:
          "The pairing QR code expired. Start the connection again.",
        pairing_failed:
          "Signal could not link this device. Start the connection again.",
        account_mismatch:
          "Link the Signal account originally used by this connection.",
        permission_denied: "This operation requires read/write access.",
        invalid_input:
          "Invalid request input. Check the required fields and formats.",
        message_not_in_synced_cache:
          "This message is not in this chat's local cache.",
        reply_context_unavailable:
          "The cached quote is unavailable or restricted. Nothing was sent.",
        poll_unavailable: "This cached message is not an open poll.",
        uncertain:
          "Delivery is uncertain. Inspect /writes with the same idempotencyKey and check Signal before sending again.",
        idempotency_conflict:
          "This idempotency key was already used for different content.",
        helper_release_unavailable:
          "The matching Signal runtime release is unavailable. Configure a local Signal CLI executable for development.",
        helper_unavailable:
          "The Signal helper stopped. Retry a read or reconnect; do not retry uncertain writes with a new key.",
        helper_failed:
          "Signal rejected the operation. Check the linked device and account identity on your phone.",
        identity_changed:
          "Signal reported an untrusted identity. Verify the contact's safety number before retrying.",
        helper_checksum_mismatch:
          "The Signal runtime checksum did not match. No downloaded program was executed.",
        unsupported_platform:
          "This runtime supports macOS and glibc Linux on x64 and ARM64.",
        core_upgrade_required:
          "Update Switchboard to enable QR device pairing.",
      }[code] ?? "Signal operation failed (" + code + ").",
    );
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
export const fail = (code, status = 400, extra) =>
  new SignalError(code, status, extra);
export function publicError(e) {
  return e instanceof SignalError
    ? { code: e.code, message: e.message }
    : {
        code: "internal_error",
        message: "The Signal adapter could not complete the operation.",
      };
}
