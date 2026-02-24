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
import type { EventEnvelope, SocketData, SocketContext, MessageRole } from './types';
import { chatWithAi } from './ai-client';
import {
  acceptHitlSession,
  endHitlSession,
  sendHitlMessage,
  getHitlSession,
  getHitlSessions,
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
  messageHistory: Array<{ role: MessageRole; content: string }>;
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

/**
 * After agent auth: fetch their claimed (accepted) sessions and push to dashboard.
 * Restores "My Conversations" when agent reconnects after logout.
 */
export async function pushAgentClaimedSessions(
  socket: WebSocket,
  context: SocketContext,
  token: string,
): Promise<void> {
  if (context.role !== 'human_agent') return;
  const workspaceIds = (context.workspace_ids?.length
    ? context.workspace_ids
    : context.tenant_id
      ? [context.tenant_id]
      : []) as string[];
  const profileId = context.user_id;

  for (const workspaceId of workspaceIds) {
    try {
      const res = await getHitlSessions(
        { workspace_id: workspaceId, status: 'accepted', page_size: 100 },
        token,
      );
      const mine = (res.items ?? []).filter(
        (s) => s.assigned_cs_profile_id === profileId,
      );
      for (const session of mine) {
        const cid = session.conversation_id;
        const state = getOrCreateState(
          cid,
          session.workspace_id,
          session.user_profile_id ?? '',
        );
        state.mode = 'accepted';
        state.assignedAgentId = profileId;
        state.needsSync = false;

        agentConversations.set(cid, socket);
        trackSocket(socket, cid);

        // Merge pre-handoff (AI+user) from in-memory state with persisted HITL messages
        const preHandoff: Array<{ id: string; role: MessageRole; content: string }> = [];
        let seenHuman = false;
        for (const m of state.messageHistory) {
          if (m.role === 'human_agent') seenHuman = true;
          if (!seenHuman) {
            preHandoff.push({
              id: `pre-${preHandoff.length}`,
              role: m.role,
              content: m.content,
            });
          }
        }
        const hitlMessages = (session.messages ?? []).map((m) => {
          const isFromUser =
            m.is_from_user === true || m.is_from_user === 'true';
          return {
            id: m.id,
            role: (isFromUser ? 'user' : 'human_agent') as MessageRole,
            content: m.content,
          };
        });
        const messages = [...preHandoff, ...hitlMessages];

        send(socket, {
          type: 'conversation_history',
          version: 1,
          payload: {
            conversation_id: cid,
            session,
            messages,
          },
          meta: { conversation_id: cid, ts: Date.now() },
        });
      }
    } catch (err) {
      console.warn(`[pushAgentClaimedSessions] workspace ${workspaceId}:`, err);
    }
  }
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

/** Send event to all human_agent dashboards for the given workspace. */
function broadcastToWorkspaceAgents(
  workspaceId: string,
  envelope: EventEnvelope,
): void {
  const wid = String(workspaceId || '').trim();
  if (!wid) {
    console.warn(`[Broadcast] Skipped ${envelope.type}: empty workspace_id from embedded chat`);
    return;
  }

  const agentWorkspaces: string[] = [];
  let sent = 0;
  for (const [ws, ctx] of humanAgentSockets) {
    const belongs =
      (Array.isArray(ctx.workspace_ids) && ctx.workspace_ids.includes(wid)) ||
      ctx.tenant_id === wid;
    if (belongs && ws.readyState === 1) {
      send(ws, envelope);
      sent++;
    }
    const list = ctx.workspace_ids?.length ? ctx.workspace_ids : (ctx.tenant_id ? [ctx.tenant_id] : []);
    agentWorkspaces.push(...list);
  }

  if (sent > 0) {
    console.log(`[Broadcast] ${envelope.type} → ${sent} agent(s) for workspace ${wid}`);
  } else {
    console.warn(
      `[Broadcast] ${envelope.type} → 0 agents for workspace ${wid}. ` +
      `Embedded chat workspace=${wid}. Agent workspaces=[${[...new Set(agentWorkspaces)].join(', ') || '(none)'}]`
    );
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
  _cid: string,
  _token: string,
): Promise<void> {
  if (!state.needsSync) return;
  state.needsSync = false;
  // HITL GET sync disabled: no longer calling getHitlSession on first message.
}

// ── Main event dispatcher ───────────────────────────────────────────

export async function handleEvent(
  envelope: EventEnvelope,
  socket: WebSocket,
  data: SocketData,
): Promise<void> {
  const ctx = data.context!;

  switch (envelope.type) {
    case 'message_send': {
      const cid = envelope.meta?.conversation_id;
      const state = cid ? conversationStates.get(cid) : undefined;
      const isAgentInActiveHitl =
        ctx.role === 'human_agent' &&
        state?.mode === 'accepted' &&
        state.assignedAgentId === ctx.user_id;
      if (isAgentInActiveHitl) {
        await handleAgentMessage(envelope, socket, data);
      } else {
        await handleUserMessage(envelope, socket, data);
      }
      break;
    }

    case 'agent_pick':
      await handleAgentPick(envelope, socket, data);
      break;

    case 'session_history_request':
      await handleSessionHistoryRequest(envelope, socket, data);
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

  state.messageHistory.push({ role: 'user', content });

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
          role: 'ai_agent',
          content: aiResponse.response,
        });

        send(socket, {
          type: 'message_receive',
          version: 1,
          payload: {
            message: aiResponse.response,
            role: 'ai_agent',
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

          console.log(`[Handoff] conversation_queued for cid=${cid} workspace=${ctx.tenant_id || '(empty)'}`);
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
            role: 'user',
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

  state.messageHistory.push({ role: 'human_agent', content });

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
        role: 'human_agent',
        sender_id: ctx.user_id,
      },
      meta: { conversation_id: cid, ts: Date.now() },
    });
  }
}

// ── Human agent requests past session history (read-only) ──────────────

async function handleSessionHistoryRequest(
  envelope: EventEnvelope,
  socket: WebSocket,
  data: SocketData,
): Promise<void> {
  const token = data.token!;
  const cid = envelope.meta?.conversation_id;
  if (!cid) {
    sendError(socket, 'conversation_id is required in meta');
    return;
  }

  try {
    const session = await getHitlSession(cid, token);
    const messages = (session.messages || []).map((m) => {
      const isFromUser =
        m.is_from_user === true || m.is_from_user === 'true';
      return {
        id: m.id,
        role: (isFromUser ? 'user' : 'human_agent') as MessageRole,
        content: m.content,
      };
    });

    send(socket, {
      type: 'session_history',
      version: 1,
      payload: {
        conversation_id: cid,
        session,
        messages,
      },
      meta: { conversation_id: cid, ts: Date.now() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load session history';
    sendError(socket, msg, cid);
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

  // Merge in-memory (pre-handoff) with persisted CRUD messages for robust history
  const preHandoff: Array<{ role: MessageRole; content: string }> = [];
  const hitlFromMem: Array<{ role: MessageRole; content: string }> = [];
  let seenHuman = false;
  for (const m of state.messageHistory) {
    if (m.role === 'human_agent') seenHuman = true;
    if (!seenHuman) preHandoff.push(m);
    else hitlFromMem.push(m);
  }
  const hitlFromCrud = (session.messages || []).map((m) => {
    const isFromUser =
      m.is_from_user === true || m.is_from_user === 'true';
    return {
      id: m.id,
      role: (isFromUser ? 'user' : 'human_agent') as MessageRole,
      content: m.content,
    };
  });
  const hitlMessages =
    hitlFromCrud.length > 0
      ? hitlFromCrud
      : hitlFromMem.map((m, i) => ({
          id: `mem-${i}`,
          role: m.role,
          content: m.content,
        }));
  const allMessages = [
    ...preHandoff.map((m, i) => ({
      id: `pre-${i}`,
      role: m.role,
      content: m.content,
    })),
    ...hitlMessages,
  ];

  send(socket, {
    type: 'conversation_history',
    version: 1,
    payload: {
      conversation_id: cid,
      session,
      messages: allMessages,
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

  let session;
  try {
    session = await endHitlSession(cid, token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to end session';
    sendError(socket, msg, cid);
    return;
  }

  state.mode = 'ai';
  state.assignedAgentId = undefined;
  agentConversations.delete(cid);

  broadcastToWorkspaceAgents(state.workspaceId, {
    type: 'conversation_ended',
    version: 1,
    payload: {
      conversation_id: cid,
      session,
    },
    meta: { conversation_id: cid, ts: Date.now() },
  });

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

    // AI follow-up: contextual message after human agent ends session
    const chatAgentId = state.chatAgentId ?? session.chat_agent_id;
    if (chatAgentId) {
      const handoffCompletePrompt =
        'The human support agent has just ended the session. Based on the conversation history, send a brief, friendly follow-up message (1-2 sentences) to the user. Acknowledge the topic if you can infer it (e.g. billing sync, order issue) and ask if they need anything else. Be warm and professional. Do not use tools or trigger handoff. In the end, ask if there human handoff was helpul.';
      chatWithAi({
        user_input: handoffCompletePrompt,
        conversation_history: state.messageHistory,
        chat_agent_id: chatAgentId,
        conversation_id: cid,
      })
        .then((aiResponse) => {
          const msg = (aiResponse?.response?.trim()) ||
            'I hope everything is resolved. Please let me know if you have anything else I can help with.';
          if (userSocket.readyState === 1) {
            state.messageHistory.push({ role: 'ai_agent', content: msg });
            send(userSocket, {
              type: 'message_receive',
              version: 1,
              payload: {
                message: msg,
                role: 'ai_agent',
              },
              meta: { conversation_id: cid, ts: Date.now() },
            });
          }
        })
        .catch((err) => {
          console.warn('[handleConversationComplete] AI follow-up failed:', err);
          if (userSocket.readyState === 1) {
            const fallback =
              'I hope everything is resolved. Please let me know if you have anything else I can help with.';
            state.messageHistory.push({ role: 'ai_agent', content: fallback });
            send(userSocket, {
              type: 'message_receive',
              version: 1,
              payload: { message: fallback, role: 'ai_agent' },
              meta: { conversation_id: cid, ts: Date.now() },
            });
          }
        });
    }
  }
}
