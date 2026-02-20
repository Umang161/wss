/**
 * Core types: roles, events, envelopes, socket state, HITL API shapes.
 */

/** Only two WS client types; AI is an HTTP API, not a socket. */
export type Role = 'user' | 'human_agent';

export type SenderType = 'user' | 'ai_agent' | 'human_agent';

export type EventType =
  | 'auth'
  | 'auth_ok'
  | 'auth_error'
  | 'ping'
  | 'pong'
  | 'message_send'
  | 'message_receive'
  | 'ai_thinking'
  | 'conversation_queued'
  | 'conversation_picked'
  | 'conversation_status_update'
  | 'conversation_history'
  | 'agent_pick'
  | 'conversation_complete'
  | 'error';

export interface EventEnvelope<T = unknown> {
  type: EventType;
  version: number;
  payload: T;
  meta?: {
    conversation_id?: string;
    tenant_id?: string;
    ts?: number;
    [key: string]: unknown;
  };
}

export interface AuthPayload {
  token: string;
}

export interface SocketContext {
  tenant_id: string;
  user_id: string;
  role: Role;
  permissions: string[];
  authenticatedAt: number;
}

export type SocketAuthState = 'UNAUTHENTICATED' | 'AUTHENTICATED';

export interface SocketData {
  authState: SocketAuthState;
  context?: SocketContext;
  /** Raw JWT kept for forwarding to CRUD API calls. */
  token?: string;
  connectedAt: number;
  lastActivityAt: number;
  authTimeout?: NodeJS.Timeout;
  idleTimeout?: NodeJS.Timeout;
  maxLifetimeTimeout?: NodeJS.Timeout;
}

// ── AI HTTP API types ───────────────────────────────────────────────

export interface AiChatRequest {
  user_input: string;
  conversation_history: Array<{ sender_type: SenderType; content: string }>;
  chat_agent_id: string;
  conversation_id: string;
}

export interface AiChatResponse {
  response: string;
  type: string;
  action_triggered: boolean;
  collecting_params: boolean;
  missing_params: string[];
  collected_params: Record<string, unknown>;
  handoff: string | boolean;
  handoff_reason: string | null;
  url: string | null;
  items: unknown;
  item_images: unknown;
  ticket_number: string | null;
  hitl_requested: unknown;
  error: string | null;
}

// ── HITL CRUD API types ─────────────────────────────────────────────

export type HitlStatus = 'waiting' | 'accepted' | 'ended';

export interface HitlMessage {
  id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  is_from_user: boolean;
  created_at: string;
}

export interface HitlSession {
  id: string;
  conversation_id: string;
  chat_agent_id: string;
  workspace_id: string;
  status: HitlStatus;
  assigned_cs_profile_id: string | null;
  user_profile_id: string | null;
  transfer_reason: string | null;
  messages: HitlMessage[];
  request_id: string | null;
  created_at: string;
  claimed_at: string | null;
  ended_at: string | null;
}

export interface HitlQueueResponse {
  items: Array<{
    id: string;
    conversation_id: string;
    chat_agent_id: string;
    workspace_id: string;
    user_profile_id: string;
    transfer_reason: string;
    created_at: string;
  }>;
  total: number;
}

export interface HitlSessionsResponse {
  items: HitlSession[];
  total: number;
  page: number;
  page_size: number;
}
