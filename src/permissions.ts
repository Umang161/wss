/**
 * Permission matrix: only user and human_agent connect via WS.
 * AI is server-side HTTP — no role entry needed.
 */
import type { Role, EventType } from './types';

const SEND: Record<EventType, Role[]> = {
  auth:                        ['user', 'human_agent'],
  auth_ok:                     [],
  auth_error:                  [],
  ping:                        ['user', 'human_agent'],
  pong:                        ['user', 'human_agent'],
  message_send:                ['user', 'human_agent'],
  message_receive:             [],
  ai_thinking:                 [],
  conversation_queued:         [],
  conversation_picked:         [],
  conversation_status_update:  [],
  conversation_history:        [],
  session_history:             [],
  agent_pick:                  ['human_agent'],
  session_history_request:    ['human_agent'],
  conversation_complete:       ['human_agent'],
  error:                       [],
};

export const UNAUTH_ALLOWED: EventType[] = ['auth', 'ping'];

export function canSendEvent(role: Role, eventType: EventType): boolean {
  const allowed = SEND[eventType];
  return Array.isArray(allowed) && allowed.includes(role);
}

export function isAllowedBeforeAuth(eventType: EventType): boolean {
  return UNAUTH_ALLOWED.includes(eventType);
}
