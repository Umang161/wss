/**
 * Event orchestrator: in-memory socket registry + conversation flow.
 *
 * All persistence goes through the HITL CRUD API — no direct DB access.
 *
 * Lifecycle:
 *   user message → AI HTTP call → (handoff? → HITL queue → agent accept)
 *   → human_agent messaging → conversation_complete → back to AI
 */
import type { WebSocket } from 'ws';
import type { EventEnvelope, SocketData, SocketContext, SenderType } from './types';
import { chatWithAi } from './ai-client';
import {
  acceptHitlSession,
  endHitlSession,
  sendHitlMessage,
  getHitlSession,
} from './hitl-client';

// ── In-memory conversation state ────────────────────────────────────

type ConversationMode = 'ai' | 'waiting' | 'accepted';

interface ConversationState {
  mode: ConversationMode;
  workspaceId: string;
  userId: string;
  /** The chat bot agent ID (required by the AI server). */
  chatAgentId?: string;
  assignedAgentId?: string;
  /** Lightweight buffer so the AI server receives context. */
  messageHistory: Array<{ sender_type: SenderType; content: string }>;
  /** True until we've synced mode with the HITL backend (handles WSS restarts). */
  needsSync: boolean;
}

const conversationStates = new Map<string, ConversationState>();

// ── In-memory socket maps ───────────────────────────────────────────

/** conversation_id → user socket. */
const userSockets = new Map<string, WebSocket>();

/** conversation_id → assigned human_agent socket. */
const agentConversations = new Map<string, WebSocket>();

/** All authenticated human_agent sockets with their decoded context. */
const humanAgentSockets = new Map<WebSocket, SocketContext>();

/** Reverse: socket → conversation_ids (for cleanup on disconnect). */
const socketConversationIds = new Map<WebSocket, Set<string>>();

// ── Registry helpers ────────────────────────────────────────────────

function registerUserSocket(conversationId: string, socket: WebSocket): void {
  userSockets.set(conversationId, socket);
  trackSocket(socket, conversationId);
}

export function registerHumanAgentSocket(
  socket: WebSocket,
  context: SocketContext,
): void {
  humanAgentSockets.set(socket, context);
}

function trackSocket(socket: WebSocket, conversationId: string): void {
  let ids = socketConversationIds.get(socket);
  if (!ids) {
    ids = new Set();
    socketConversationIds.set(socket, ids);
  }
  ids.add(conversationId);
}

export function onSocketClose(socket: WebSocket): void {
  humanAgentSockets.delete(socket);

  const ids = socketConversationIds.get(socket);
  if (ids) {
    for (const cid of ids) {
      if (userSockets.get(cid) === socket) userSockets.delete(cid);
      if (agentConversations.get(cid) === socket) agentConversations.delete(cid);
    }
  }
  socketConversationIds.delete(socket);
}

// ── Envelope helpers ────────────────────────────────────────────────

function send(ws: WebSocket, envelope: EventEnvelope): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(envelope));
}

function broadcastToWorkspaceAgents(
  workspaceId: string,
  envelope: EventEnvelope,
): void {
  for (const [ws, ctx] of humanAgentSockets) {
    if (ctx.tenant_id === workspaceId) {
      send(ws, envelope);
    }
  }
}

function sendError(
  ws: WebSocket,
  message: string,
  conversationId?: string,
): void {
  send(ws, {
    type: 'error',
    version: 1,
    payload: { message },
    meta: conversationId
      ? { conversation_id: conversationId, ts: Date.now() }
      : { ts: Date.now() },
  });
}

// ── Conversation state helpers ──────────────────────────────────────

function getOrCreateState(
  cid: string,
  workspaceId: string,
  userId: string,
): ConversationState {
  let state = conversationStates.get(cid);
  if (!state) {
    state = {
      mode: 'ai',
      workspaceId,
      userId,
      messageHistory: [],
      needsSync: true,
    };
    conversationStates.set(cid, state);
  }
  return state;
}

/**
 * On first interaction after WSS (re)start, check the HITL backend
 * so we don't accidentally route a live HITL conversation to the AI.
 */
async function syncStateIfNeeded(
  state: ConversationState,
  cid: string,
  token: string,
): Promise<void> {
  if (!state.needsSync) return;
  state.needsSync = false;

  try {
    const session = await getHitlSession(cid, token);
    if (session.status === 'waiting') {
      state.mode = 'waiting';
    } else if (session.status === 'accepted') {
      state.mode = 'accepted';
      state.assignedAgentId = session.assigned_cs_profile_id ?? undefined;
    }
  } catch {
    // 404 or network error → no active HITL session, stay in AI mode.
  }
}

// ── Main event dispatcher ───────────────────────────────────────────

export async function handleEvent(
  envelope: EventEnvelope,
  socket: WebSocket,
  data: SocketData,
): Promise<void> {
  const ctx = data.context!;

  switch (envelope.type) {
    case 'message_send':
      if (ctx.role === 'user') {
        await handleUserMessage(envelope, socket, data);
      } else if (ctx.role === 'human_agent') {
        await handleAgentMessage(envelope, socket, data);
      }
      break;

    case 'agent_pick':
      await handleAgentPick(envelope, socket, data);
      break;

    case 'conversation_complete':
      await handleConversationComplete(envelope, socket, data);
      break;

    default:
      sendError(
        socket,
        `Unhandled event type: ${envelope.type}`,
        envelope.meta?.conversation_id,
      );
  }
}

// ── User sends a message ────────────────────────────────────────────

async function handleUserMessage(
  envelope: EventEnvelope,
  socket: WebSocket,
  data: SocketData,
): Promise<void> {
  const ctx = data.context!;
  const token = data.token!;
  const cid = envelope.meta?.conversation_id;
  if (!cid) {
    sendError(socket, 'conversation_id is required in meta');
    return;
  }

  registerUserSocket(cid, socket);

  const state = getOrCreateState(cid, ctx.tenant_id, ctx.user_id);
  await syncStateIfNeeded(state, cid, token);

  const agentId = envelope.meta?.agent_id as string | undefined;
  if (agentId) state.chatAgentId = agentId;

  const content =
    typeof (envelope.payload as Record<string, unknown>)?.message === 'string'
      ? ((envelope.payload as Record<string, unknown>).message as string)
      : JSON.stringify(envelope.payload);

  state.messageHistory.push({ sender_type: 'user', content });

  switch (state.mode) {
    case 'ai': {
      if (!state.chatAgentId) {
        sendError(socket, 'agent_id is required in meta', cid);
        return;
      }

      send(socket, {
        type: 'ai_thinking',
        version: 1,
        payload: {},
        meta: { conversation_id: cid, ts: Date.now() },
      });

      try {
        const aiResponse = await chatWithAi({
          user_input: content,
          conversation_history: state.messageHistory,
          chat_agent_id: state.chatAgentId,
          conversation_id: cid,
        });

        state.messageHistory.push({
          sender_type: 'ai_agent',
          content: aiResponse.response,
        });

        send(socket, {
          type: 'message_receive',
          version: 1,
          payload: {
            message: aiResponse.response,
            sender_type: 'ai_agent',
          },
          meta: { conversation_id: cid, ts: Date.now() },
        });

        const shouldHandoff =
          aiResponse.handoff === true || aiResponse.handoff === 'true';

        if (shouldHandoff) {
          state.mode = 'waiting';

          send(socket, {
            type: 'conversation_status_update',
            version: 1,
            payload: {
              status: 'waiting',
              message: 'Connecting you with a support agent…',
            },
            meta: { conversation_id: cid, ts: Date.now() },
          });

          broadcastToWorkspaceAgents(ctx.tenant_id, {
            type: 'conversation_queued',
            version: 1,
            payload: {
              conversation_id: cid,
              workspace_id: ctx.tenant_id,
              user_id: ctx.user_id,
              handoff_reason: aiResponse.handoff_reason ?? null,
            },
            meta: { conversation_id: cid, ts: Date.now() },
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'AI request failed';
        sendError(socket, msg, cid);
      }
      break;
    }

    case 'waiting': {
      send(socket, {
        type: 'conversation_status_update',
        version: 1,
        payload: {
          status: 'waiting',
          message:
            'Your message has been received. An agent will be with you shortly.',
        },
        meta: { conversation_id: cid, ts: Date.now() },
      });
      break;
    }

    case 'accepted': {
      const agentSocket = agentConversations.get(cid);
      if (agentSocket && agentSocket.readyState === 1) {
        send(agentSocket, {
          type: 'message_receive',
          version: 1,
          payload: {
            message: content,
            sender_type: 'user',
            sender_id: ctx.user_id,
          },
          meta: { conversation_id: cid, ts: Date.now() },
        });

        sendHitlMessage(cid, content, token).catch((err) => {
          console.warn(`Failed to persist user message for ${cid}:`, err);
        });
      } else {
        sendError(socket, 'Agent is currently unavailable', cid);
      }
      break;
    }
  }
}

// ── Human agent sends a message ─────────────────────────────────────

async function handleAgentMessage(
  envelope: EventEnvelope,
  socket: WebSocket,
  data: SocketData,
): Promise<void> {
  const ctx = data.context!;
  const token = data.token!;
  const cid = envelope.meta?.conversation_id;
  if (!cid) {
    sendError(socket, 'conversation_id is required in meta');
    return;
  }

  const state = conversationStates.get(cid);
  if (!state || state.mode !== 'accepted') {
    sendError(socket, 'Conversation is not in an active HITL session', cid);
    return;
  }
  if (state.assignedAgentId !== ctx.user_id) {
    sendError(
      socket,
      'You are not the assigned agent for this conversation',
      cid,
    );
    return;
  }

  const content =
    typeof (envelope.payload as Record<string, unknown>)?.message === 'string'
      ? ((envelope.payload as Record<string, unknown>).message as string)
      : JSON.stringify(envelope.payload);

  state.messageHistory.push({ sender_type: 'human_agent', content });

  try {
    await sendHitlMessage(cid, content, token);
  } catch (err) {
    console.warn(`Failed to persist agent message for ${cid}:`, err);
  }

  const userSocket = userSockets.get(cid);
  if (userSocket && userSocket.readyState === 1) {
    send(userSocket, {
      type: 'message_receive',
      version: 1,
      payload: {
        message: content,
        sender_type: 'human_agent',
        sender_id: ctx.user_id,
      },
      meta: { conversation_id: cid, ts: Date.now() },
    });
  }
}

// ── Human agent picks (accepts) a queued conversation ───────────────

async function handleAgentPick(
  envelope: EventEnvelope,
  socket: WebSocket,
  data: SocketData,
): Promise<void> {
  const ctx = data.context!;
  const token = data.token!;
  const cid = envelope.meta?.conversation_id;
  if (!cid) {
    sendError(socket, 'conversation_id is required in meta');
    return;
  }

  const state = conversationStates.get(cid);
  if (!state || state.mode !== 'waiting') {
    sendError(socket, 'Conversation is not in the queue', cid);
    return;
  }

  let session;
  try {
    session = await acceptHitlSession(cid, token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to accept session';
    sendError(socket, msg, cid);
    return;
  }

  state.mode = 'accepted';
  state.assignedAgentId = ctx.user_id;
  agentConversations.set(cid, socket);
  trackSocket(socket, cid);

  send(socket, {
    type: 'conversation_history',
    version: 1,
    payload: {
      conversation_id: cid,
      session,
      messages: state.messageHistory.map((m, i) => ({
        id: String(i),
        sender_type: m.sender_type,
        content: m.content,
      })),
    },
    meta: { conversation_id: cid, ts: Date.now() },
  });

  const userSocket = userSockets.get(cid);
  if (userSocket && userSocket.readyState === 1) {
    send(userSocket, {
      type: 'conversation_status_update',
      version: 1,
      payload: {
        status: 'accepted',
        message: 'A support agent has joined the conversation.',
      },
      meta: { conversation_id: cid, ts: Date.now() },
    });
  }

  broadcastToWorkspaceAgents(state.workspaceId, {
    type: 'conversation_picked',
    version: 1,
    payload: {
      conversation_id: cid,
      assigned_cs_profile_id: session.assigned_cs_profile_id,
    },
    meta: { conversation_id: cid, ts: Date.now() },
  });
}

// ── Human agent ends the HITL session → user back to AI ─────────────

async function handleConversationComplete(
  envelope: EventEnvelope,
  socket: WebSocket,
  data: SocketData,
): Promise<void> {
  const ctx = data.context!;
  const token = data.token!;
  const cid = envelope.meta?.conversation_id;
  if (!cid) {
    sendError(socket, 'conversation_id is required in meta');
    return;
  }

  const state = conversationStates.get(cid);
  if (!state || state.mode !== 'accepted') {
    sendError(socket, 'No active HITL session for this conversation', cid);
    return;
  }
  if (state.assignedAgentId !== ctx.user_id) {
    sendError(
      socket,
      'You are not the assigned agent for this conversation',
      cid,
    );
    return;
  }

  try {
    await endHitlSession(cid, token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to end session';
    sendError(socket, msg, cid);
    return;
  }

  state.mode = 'ai';
  state.assignedAgentId = undefined;
  agentConversations.delete(cid);

  const userSocket = userSockets.get(cid);
  if (userSocket && userSocket.readyState === 1) {
    send(userSocket, {
      type: 'conversation_status_update',
      version: 1,
      payload: {
        status: 'ai_active',
        message: 'You are now chatting with the AI assistant.',
      },
      meta: { conversation_id: cid, ts: Date.now() },
    });
  }
}
