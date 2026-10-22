---
title: Using Signal operations
services: [signal]
order: 2
---

# Using Signal operations

Select the connection in the API console to discover operations. Switchboard's call API and MCP discovery expose the same operations.

Read `/chats` for exact chat IDs, then `/messages?chat=...` for message IDs. Retain a pagination cursor with its original account/chat/filter.

## Send and quote

```json
{
  "chat": "d:22222222-2222-4222-8222-222222222222",
  "text": "Hello",
  "idempotencyKey": "my-intentional-send-001"
}
```

Optionally pass `replyTo` with an exact cached message ID. Missing, deleted or restricted quote context fails without sending. Empty `replyTo` is equivalent to omission.

## Reactions

```json
{
  "chat": "d:22222222-2222-4222-8222-222222222222",
  "messageId": "EXACT_CACHED_MESSAGE_ID",
  "emoji": "👍",
  "idempotencyKey": "my-reaction-001"
}
```

Empty emoji removes your reaction. Signal requires the original emoji, so it must already be cached.

## Poll votes

```json
{
  "chat": "g:EXACT_GROUP_ID_FROM_CHAT_LIST",
  "messageId": "EXACT_CACHED_POLL_ID",
  "options": ["Exact option text"],
  "idempotencyKey": "my-poll-vote-001"
}
```

Empty options withdraw your vote. Single-choice polls allow at most one option. Missing/ambiguous labels, closed polls and uncached polls fail without guessing. Vote counters survive restarts and incorporate received self-vote transcripts.

## Receipts and history

Accepted writes return a timestamp and chat. `/writes?idempotencyKey=...` returns `accepted` with a saved receipt, `attempted` for uncertain delivery, or `unknown` for an unused key. Accepted replays remain available after their targets leave the cache.

History is received/synced cache only. A just-sent message appears only if Signal supplies its event. Helper readiness means a running process and saved local account, not proven server reachability or recipient delivery.

Media transfer, typing, read-receipt sending, calls, edits, deleting messages, creating polls and group administration are not exposed.
