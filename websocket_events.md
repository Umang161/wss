# WebSocket Events Reference

WebSocket server URL: `ws://<host>:8080`

All messages are JSON with this envelope format:

```json
{
  "type": "<event_type>",
  "version": 1,
  "payload": { ... },
  "meta": {
    "conversation_id": "<uuid>",
    "ts": 1771579480226
  }
}
```

---

## Connection & Authentication

Both UIs must authenticate immediately after connecting.

### JWT Payload

| Role | JWT `role` field | JWT `sub` field |
|------|-----------------|-----------------|
| Chat UI user | `user` | user's profile ID |
| Dashboard agent | `human_agent` | CS agent's profile ID |

Both JWTs must include `tenant_id` (workspace ID).

---

### `auth` — Client → Server

Send immediately after WebSocket connects.

```json
{
  "type": "auth",
  "version": 1,
  "payload": {
    "token": "<jwt_token>"
  }
}
```

### `auth_ok` — Server → Client

Authentication succeeded.

```json
{
  "type": "auth_ok",
  "version": 1,
  "payload": {}
}
```

### `auth_error` — Server → Client

Authentication failed. Connection will be closed.

```json
{
  "type": "auth_error",
  "version": 1,
  "payload": {
    "message": "Invalid token"
  }
}
```

---

### `ping` / `pong` — Bidirectional

Keepalive. Client can send `ping`, server replies with `pong`.

```json
{ "type": "ping", "version": 1, "payload": {} }
```
```json
{ "type": "pong", "version": 1, "payload": {} }
```

---

## Chat UI (role: `user`)

### Events the Chat UI SENDS

#### `message_send` — Send a chat message

```json
{
  "type": "message_send",
  "version": 1,
  "payload": {
    "message": "I need help with my order"
  },
  "meta": {
    "conversation_id": "conv-uuid",
    "agent_id": "chat-agent-uuid"
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `payload.message` | Yes | The user's message text |
| `meta.conversation_id` | Yes | UUID identifying this conversation |
| `meta.agent_id` | Yes (first message) | The chat bot agent UUID. Required on the first message; stored for subsequent messages so can be omitted after. |

---

### Events the Chat UI RECEIVES

#### `ai_thinking` — AI is processing

Sent immediately when the AI starts processing the user's message. Use this to show a loading/typing indicator.

```json
{
  "type": "ai_thinking",
  "version": 1,
  "payload": {},
  "meta": {
    "conversation_id": "conv-uuid",
    "ts": 1771579480226
  }
}
```

#### `message_receive` — Incoming message

A message from the AI or from a human agent.

```json
{
  "type": "message_receive",
  "version": 1,
  "payload": {
    "message": "The capital of Rajasthan is Jaipur.",
    "role": "ai_agent",
  },
  "meta": {
    "conversation_id": "conv-uuid",
    "ts": 1771579480226
  }
}
```

| Field | Values | Notes |
|-------|--------|-------|
| `payload.message` | string | The message text |
| `payload.role` | `"user"`, `"ai_agent"`, or `"human_agent"` | Who sent it |
| `payload.sender_id` | string (only for `human_agent`) | The CS agent's profile ID |

#### `conversation_status_update` — Conversation state changed

Sent when the conversation transitions between modes.

```json
{
  "type": "conversation_status_update",
  "version": 1,
  "payload": {
    "status": "waiting",
    "message": "Connecting you with a support agent…"
  },
  "meta": {
    "conversation_id": "conv-uuid",
    "ts": 1771579480226
  }
}
```

| `status` value | Meaning | What to show |
|----------------|---------|------------|
| `"waiting"` | Handed off to human queue, waiting for agent | "Connecting you with a support agent…" or "An agent will be with you shortly." |
| `"accepted"` | A human agent has joined | "A support agent has joined the conversation." |
| `"ai_active"` | Back to AI (agent ended the session) | "You are now chatting with the AI assistant." |

#### `error` — Something went wrong

```json
{
  "type": "error",
  "version": 1,
  "payload": {
    "message": "AI request failed"
  },
  "meta": {
    "conversation_id": "conv-uuid",
    "ts": 1771579480226
  }
}
```

---

## Human Agent Dashboard (role: `human_agent`)

### Events the Dashboard SENDS

#### `agent_pick` — Accept a queued conversation

Agent claims a waiting ticket. The backend marks them as the assigned CS agent.

```json
{
  "type": "agent_pick",
  "version": 1,
  "payload": {},
  "meta": {
    "conversation_id": "conv-uuid"
  }
}
```

#### `message_send` — Send a message to the user

```json
{
  "type": "message_send",
  "version": 1,
  "payload": {
    "message": "Hi! I'm looking into your order now."
  },
  "meta": {
    "conversation_id": "conv-uuid"
  }
}
```

#### `conversation_complete` — End the HITL session

Ends the support session. The user returns to the AI assistant.

```json
{
  "type": "conversation_complete",
  "version": 1,
  "payload": {},
  "meta": {
    "conversation_id": "conv-uuid"
  }
}
```

---

### Events the Dashboard RECEIVES

#### `conversation_queued` — New ticket in the queue

Broadcast to all agents in the same workspace when a conversation is handed off from AI to the human queue.

```json
{
  "type": "conversation_queued",
  "version": 1,
  "payload": {
    "conversation_id": "conv-uuid",
    "workspace_id": "workspace-uuid",
    "user_id": "user-uuid",
    "handoff_reason": "User requested human support"
  },
  "meta": {
    "conversation_id": "conv-uuid",
    "ts": 1771579480226
  }
}
```

| Field | Notes |
|-------|-------|
| `payload.conversation_id` | Use this to call `agent_pick` |
| `payload.workspace_id` | The workspace this ticket belongs to |
| `payload.user_id` | The end user's profile ID |
| `payload.handoff_reason` | Why the AI handed off (may be `null`) |

#### `conversation_picked` — Ticket claimed by an agent

Broadcast to all agents in the workspace when someone accepts a ticket. Use this to remove the ticket from the queue UI.

```json
{
  "type": "conversation_picked",
  "version": 1,
  "payload": {
    "conversation_id": "conv-uuid",
    "assigned_cs_profile_id": "cs-agent-uuid"
  },
  "meta": {
    "conversation_id": "conv-uuid",
    "ts": 1771579480226
  }
}
```

#### `conversation_history` — Full chat history after accepting

Sent to the agent who accepted the ticket. Contains the entire conversation history (AI + user messages) and the HITL session details.

```json
{
  "type": "conversation_history",
  "version": 1,
  "payload": {
    "conversation_id": "conv-uuid",
    "session": {
      "id": "session-uuid",
      "conversation_id": "conv-uuid",
      "chat_agent_id": "bot-uuid",
      "workspace_id": "workspace-uuid",
      "status": "accepted",
      "assigned_cs_profile_id": "cs-agent-uuid",
      "user_profile_id": "user-uuid",
      "transfer_reason": "User requested human support",
      "messages": [],
      "created_at": "2026-02-21T10:30:00Z",
      "claimed_at": "2026-02-21T10:30:45Z",
      "ended_at": null
    },
    "messages": [
      { "id": "0", "role": "user", "content": "Hi, I need help" },
      { "id": "1", "role": "ai_agent", "content": "Let me connect you with a human agent." }
    ]
  },
  "meta": {
    "conversation_id": "conv-uuid",
    "ts": 1771579480226
  }
}
```

#### `message_receive` — Message from the user

Received when the user sends a message during an active HITL session.

```json
{
  "type": "message_receive",
  "version": 1,
  "payload": {
    "message": "Can you check order #12345?",
    "role": "user",
    "sender_id": "user-uuid"
  },
  "meta": {
    "conversation_id": "conv-uuid",
    "ts": 1771579480226
  }
}
```

#### `error` — Something went wrong

```json
{
  "type": "error",
  "version": 1,
  "payload": {
    "message": "Conversation is not in the queue"
  },
  "meta": {
    "conversation_id": "conv-uuid",
    "ts": 1771579480226
  }
}
```

---

## Full Flow Diagram

```
CHAT UI (user)                    SERVER                    DASHBOARD (human_agent)
──────────────                    ──────                    ───────────────────────
    auth ──────────────────────────►
    ◄────────────────────────── auth_ok
                                                                auth ──────────────►
                                                                ◄────────────── auth_ok

1. USER CHATS WITH AI
    message_send ──────────────────►
    ◄──────────────────── ai_thinking
    ◄────────────────── message_receive
                        (role: ai_agent)

2. AI HANDS OFF → QUEUED
    ◄──── conversation_status_update                   conversation_queued ────►
          (status: waiting)

3. AGENT ACCEPTS
                                                                agent_pick ────────►
    ◄──── conversation_status_update              conversation_history ────────────►
          (status: accepted)                      conversation_picked ─────────────►
                                                  (broadcast to all agents)

4. USER ↔ AGENT CHAT
    message_send ──────────────────►
                                    ────────── message_receive ──────────────────────►
                                                                message_send ────────►
    ◄────────────────── message_receive

5. AGENT ENDS SESSION → BACK TO AI
                                                         conversation_complete ──────►
    ◄──── conversation_status_update
          (status: ai_active)

6. USER RESUMES AI CHAT
    message_send ──────────────────►
    ◄──────────────────── ai_thinking
    ◄────────────────── message_receive
                        (role: ai_agent)
```

---

## Error Handling

All errors come as:

```json
{
  "type": "error",
  "version": 1,
  "payload": { "message": "description of what went wrong" },
  "meta": { "conversation_id": "conv-uuid", "ts": 1771579480226 }
}
```

Common error messages:

| Error | When |
|-------|------|
| `"conversation_id is required in meta"` | Missing `conversation_id` in `meta` |
| `"agent_id is required in meta"` | First `message_send` from user without `agent_id` |
| `"Conversation is not in the queue"` | `agent_pick` on a conversation that isn't `waiting` |
| `"Conversation is not in an active HITL session"` | Agent tries to message a non-active session |
| `"You are not the assigned agent for this conversation"` | Wrong agent tries to message or end |
| `"Agent is currently unavailable"` | User messages during HITL but agent socket is gone |
| `"Failed to accept session"` | Backend rejected the accept (already claimed, etc.) |
| `"Permission denied for event: <type>"` | Role not allowed to send this event type |
