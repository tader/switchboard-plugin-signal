import { messagingOperations } from "./messaging-schema.js";
import { operations as legacyOperations } from "./operations.js";
import { validate } from "./validate.js";
import { digest } from "./cache.js";
import { fail } from "./errors.js";
function conversation(raw) {
  const time = new Date(raw.lastMessageAt ?? raw.updated ?? 0);
  return {
    id: raw.id,
    title: raw.name ?? "",
    kind: raw.type ?? raw.kind,
    unread: null,
    updatedAt:
      Number.isFinite(time.valueOf()) && time.valueOf() > 0
        ? time.toISOString()
        : null,
  };
}
function message(raw, account) {
  const state =
    raw.type === "deleted"
      ? "deleted"
      : raw.restricted
        ? "restricted"
        : typeof raw.text === "string" || typeof raw.poll?.question === "string"
          ? "available"
          : "unavailable";
  const time = new Date(raw.timestamp);
  const reactions = new Map();
  for (const [actor, emoji] of Object.entries(raw.reactions ?? {})) {
    if (!reactions.has(emoji))
      reactions.set(emoji, { emoji, count: null, me: null });
    if (actor === account) reactions.get(emoji).me = true;
  }
  return {
    id: raw.id,
    conversationId: raw.chat,
    text: state === "available" ? (raw.text ?? raw.poll.question) : null,
    authorId: raw.author ?? null,
    isOwn: typeof raw.author === "string" ? raw.author === account : null,
    createdAt: Number.isFinite(time.valueOf()) ? time.toISOString() : null,
    contentState: state,
    contentType: ["text", "media", "poll"].includes(raw.type)
      ? raw.type
      : "unknown",
    ...(raw.quote &&
    typeof raw.quote.author === "string" &&
    Number.isSafeInteger(raw.quote.timestamp)
      ? {
          replyToId: digest(
            JSON.stringify([
              account,
              raw.chat,
              raw.quote.author,
              raw.quote.timestamp,
            ]),
          ),
        }
      : {}),
    ...(reactions.size ? { reactions: [...reactions.values()] } : {}),
  };
}
function bound(ctx, kind, input) {
  return {
    connection: ctx.connection.id,
    kind,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  };
}
function unwrap(cursor, binding) {
  if (!cursor) return undefined;
  try {
    const x = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      JSON.stringify(x.binding) !== JSON.stringify(binding) ||
      typeof x.cursor !== "string"
    )
      throw Error();
    return x.cursor;
  } catch {
    throw fail("invalid_cursor", 400);
  }
}
function page(raw, binding, transform) {
  return {
    items: raw.items.map(transform),
    ...(raw.nextCursor
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ binding, cursor: raw.nextCursor }),
          ).toString("base64url"),
        }
      : {}),
    coverage: { complete: false, reason: "synced_cache_only" },
  };
}
const rejectedCodes = new Set([
  "invalid_input",
  "invalid_request",
  "chat_not_in_synced_cache",
  "message_not_in_synced_cache",
  "reply_context_unavailable",
  "reaction_not_in_synced_cache",
  "permission_denied",
  "unsupported_operation",
]);
export function createMessagingContract(service, pool) {
  const invokeLegacy = async (id, input, ctx) => {
    const op = legacyOperations.find((o) => o.id === id);
    return service.invoke(op, validate(input, op.input), ctx.connection);
  };
  const key = (ctx) => {
    if (typeof ctx.idempotencyKey !== "string" || !ctx.idempotencyKey)
      throw fail("invalid_request", 400);
    return digest(
      JSON.stringify(["contract-v1", ctx.connection.id, ctx.idempotencyKey]),
    );
  };
  const write = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      if (error?.code === "uncertain") return { status: "uncertain" };
      if (rejectedCodes.has(error?.code))
        return { status: "rejected", code: error.code };
      throw error;
    }
  };
  const op = (name, invoke) => ({
    category: "messaging",
    readOnly: /\.(list|get)$/.test(name),
    ...messagingOperations[name],
    invoke,
  });
  const definitions = {
    "messaging.conversations.list": op(
      "messaging.conversations.list",
      async (input, ctx) => {
        const b = bound(ctx, "conversations", input);
        const raw = await invokeLegacy(
          "listSignalChats",
          {
            limit: input.limit ?? 50,
            ...(input.cursor ? { cursor: unwrap(input.cursor, b) } : {}),
          },
          ctx,
        );
        return page(raw, b, conversation);
      },
    ),
    "messaging.conversations.get": op(
      "messaging.conversations.get",
      async (input, ctx) => {
        const s = await pool.session(ctx.connection);
        return conversation(s.cache.chat(input.id));
      },
    ),
    "messaging.messages.list": op(
      "messaging.messages.list",
      async (input, ctx) => {
        const b = bound(ctx, "messages", input);
        const raw = await invokeLegacy(
          "listSignalMessages",
          {
            chat: input.conversationId,
            limit: input.limit ?? 50,
            ...(input.cursor ? { cursor: unwrap(input.cursor, b) } : {}),
          },
          ctx,
        );
        return page(raw, b, (item) =>
          message(item, ctx.connection.credentials.account),
        );
      },
    ),
    "messaging.messages.get": op("messaging.messages.get", async (input, ctx) =>
      message(
        await invokeLegacy(
          "getSignalMessage",
          { chat: input.conversationId, messageId: input.id },
          ctx,
        ),
        ctx.connection.credentials.account,
      ),
    ),
    "messaging.messages.send": op(
      "messaging.messages.send",
      async (input, ctx) =>
        write(async () => {
          if (input.threadId) throw fail("unsupported_operation", 400);
          const raw = await invokeLegacy(
            "sendSignalMessage",
            {
              chat: input.conversationId,
              text: input.text,
              idempotencyKey: key(ctx),
              ...(input.replyToId ? { replyTo: input.replyToId } : {}),
            },
            ctx,
          );
          return {
            status: "accepted",
            resourceId: digest(
              JSON.stringify([
                ctx.connection.credentials.account,
                input.conversationId,
                ctx.connection.credentials.account,
                raw.timestamp,
              ]),
            ),
          };
        }),
    ),
    "messaging.reactions.update": op(
      "messaging.reactions.update",
      async (input, ctx) =>
        write(async () => {
          if (input.remove) {
            const s = await pool.session(ctx.connection);
            const target = s.cache.message(
              input.conversationId,
              input.messageId,
            );
            if (target.reactions?.[s.account] !== input.emoji)
              throw fail("reaction_not_in_synced_cache", 409);
          }
          await invokeLegacy(
            "reactSignalMessage",
            {
              chat: input.conversationId,
              messageId: input.messageId,
              emoji: input.remove ? "" : input.emoji,
              idempotencyKey: key(ctx),
            },
            ctx,
          );
          return { status: "accepted", resourceId: input.messageId };
        }),
    ),
  };
  definitions["messaging.messages.send"].inputSchema = structuredClone(
    definitions["messaging.messages.send"].inputSchema,
  );
  definitions["messaging.messages.send"].inputSchema.properties.text.maxLength =
    4000;
  definitions[
    "messaging.messages.send"
  ].inputSchema.properties.text.description =
    "Up to 4000 UTF-16 code units; longer input is rejected without sending.";
  delete definitions["messaging.messages.send"].inputSchema.properties.threadId;
  return {
    version: 1,
    operations: definitions,
    available(conn) {
      if (
        conn.methodId !== "linked-device" ||
        !conn.credentials?.profile ||
        !conn.credentials?.cacheId ||
        !conn.credentials?.account
      )
        return [];
      return Object.keys(definitions).filter(
        (name) => definitions[name].readOnly || conn.config.access === "write",
      );
    },
    async watch(input, ctx) {
      const s = await pool.session(ctx.connection);
      let cursor = input.checkpoint;
      while (!ctx.signal.aborted) {
        if (s.bridge.closed) throw fail("helper_unavailable", 503);
        const batch = s.cache.changes(cursor);
        if (batch.events.length) {
          await ctx.publish(batch);
          cursor = batch.checkpoint;
          continue;
        }
        await s.cache.waitForChange(cursor, ctx.signal);
      }
    },
  };
}
