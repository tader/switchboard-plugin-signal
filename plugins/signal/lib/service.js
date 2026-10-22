import { fail } from "./errors.js";
export class Service {
  constructor(ctx, pool) {
    this.ctx = ctx;
    this.pool = pool;
  }
  async invoke(op, input, conn) {
    if (op.write && conn.config.access !== "write")
      throw fail("permission_denied", 403);
    const s = await this.pool.session(conn),
      cache = s.cache;
    if (op.id === "getSignalStatus")
      return {
        ready: !s.bridge.closed,
        account: s.account,
        lastEventAt: s.lastEventAt,
        historyCoverage: "synced_cache_only",
        discoveryIncomplete: !!s.discoveryIncomplete,
        transport: "local_helper_running",
        lastError: s.bridge.lastError ?? null,
      };
    if (op.id === "getSignalCapabilities")
      return {
        access: conn.config.access,
        historyCoverage: "synced_cache_only",
        automaticReadMarkers: false,
        sessionTransfer: false,
        features: {
          chats: true,
          history: true,
          send: conn.config.access === "write",
          reply: conn.config.access === "write",
          reactions: conn.config.access === "write",
          pollVotes: conn.config.access === "write",
          pollResults: false,
          historyBackfill: false,
          mediaDownload: false,
        },
      };
    if (op.id === "listSignalChats") return cache.page("chats", input);
    if (op.id === "listSignalMessages") return cache.page("messages", input);
    if (op.id === "getSignalMessage")
      return cache.message(input.chat, input.messageId);
    if (op.id === "getSignalWriteStatus")
      return cache.inspect(input.idempotencyKey);
    const body = { ...input };
    if (body.replyTo === "") delete body.replyTo;
    const payload = { operation: op.id, ...body };
    const replay = cache.replay(input.idempotencyKey, payload);
    if (replay) return replay;
    const chat = cache.chat(input.chat),
      route =
        chat.kind === "group"
          ? { groupId: [chat.target] }
          : { recipient: [chat.target] };
    let method,
      params = { account: s.account, ...route };
    if (op.id === "sendSignalMessage") {
      method = "send";
      params.message = input.text;
      if (input.replyTo) {
        const target = cache.message(input.chat, input.replyTo);
        if (
          target.restricted ||
          !["text", "poll"].includes(target.type) ||
          (!target.text && !target.poll)
        )
          throw fail("reply_context_unavailable", 409);
        Object.assign(params, {
          quoteTimestamp: target.timestamp,
          quoteAuthor: target.author,
          quoteMessage: target.text ?? target.poll.question,
        });
      }
    } else if (op.id === "reactSignalMessage") {
      const target = cache.message(input.chat, input.messageId);
      if (target.restricted || target.type === "deleted")
        throw fail("reply_context_unavailable", 409);
      method = "sendReaction";
      Object.assign(params, {
        targetTimestamp: target.timestamp,
        targetAuthor: target.author,
        emoji: input.emoji,
        remove: input.emoji === "",
      });
      // Signal needs the original emoji when withdrawing a reaction.
      if (params.remove) {
        params.emoji = target.reactions?.[s.account];
        if (!params.emoji) throw fail("reaction_not_in_synced_cache", 409);
      }
    } else if (op.id === "voteSignalPoll") {
      const target = cache.message(input.chat, input.messageId);
      if (target.restricted || !target.poll || target.poll.closed)
        throw fail("poll_unavailable", 409);
      if (!target.poll.allowMultiple && input.options.length > 1)
        throw fail("invalid_input");
      const indexes = input.options.map((option) =>
        target.poll.options.indexOf(option),
      );
      if (
        indexes.some(
          (i, n) =>
            i < 0 ||
            target.poll.options.filter((x) => x === input.options[n]).length !==
              1,
        ) ||
        new Set(indexes).size !== indexes.length
      )
        throw fail("invalid_input");
      method = "sendPollVote";
      Object.assign(params, {
        pollAuthor: target.author,
        pollTimestamp: target.timestamp,
        option: indexes,
      });
    } else throw fail("unsupported_operation");
    return cache.write(input.idempotencyKey, payload, async () => {
      if (method === "sendPollVote")
        params.voteCount = cache.nextVote(input.messageId);
      const result = await s.bridge.call(method, params, 60000);
      if (
        !Number.isSafeInteger(result?.timestamp) ||
        !Array.isArray(result.results) ||
        !result.results.length ||
        result.results.some((r) => r.type !== "SUCCESS")
      )
        throw fail("uncertain", 409);
      const receipt = {
        ok: true,
        chat: input.chat,
        timestamp: result.timestamp,
      };
      if (method === "sendReaction")
        cache.updateTarget(
          input.chat,
          params.targetAuthor,
          params.targetTimestamp,
          (m) => {
            const reactions = { ...m.reactions };
            if (params.remove) delete reactions[s.account];
            else reactions[s.account] = params.emoji;
            return { ...m, reactions };
          },
        );
      // Do not archive the text from a write request: only provider receive/sync
      // events establish disappearing/view-once status for cached message bodies.
      return receipt;
    });
  }
  dispose() {}
}
