/**
 * HTTP client for the HITL CRUD backend API.
 * Every call forwards the caller's JWT so the backend can authorise
 * and identify the user / CS agent.
 */
import { config } from './config';
import type { HitlSession, HitlQueueResponse, HitlSessionsResponse } from './types';

async function hitlFetch<T>(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${config.crudServerAddress}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.crudRequestTimeoutMs,
  );

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers as Record<string, string> | undefined),
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HITL API ${res.status}: ${body}`);
    }

    return (await res.json()) as T;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('HITL API request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Queue & sessions ────────────────────────────────────────────────

export async function getHitlQueue(
  params: { workspace_id?: string; agent_id?: string },
  token: string,
): Promise<HitlQueueResponse> {
  const qs = new URLSearchParams();
  if (params.workspace_id) qs.set('workspace_id', params.workspace_id);
  if (params.agent_id) qs.set('agent_id', params.agent_id);
  return hitlFetch<HitlQueueResponse>(`/hitl/queue?${qs}`, token);
}

export async function getHitlSessions(
  params: {
    workspace_id?: string;
    agent_id?: string;
    status?: string;
    page?: number;
    page_size?: number;
  },
  token: string,
): Promise<HitlSessionsResponse> {
  const qs = new URLSearchParams();
  if (params.workspace_id) qs.set('workspace_id', params.workspace_id);
  if (params.agent_id) qs.set('agent_id', params.agent_id);
  if (params.status) qs.set('status', params.status);
  if (params.page) qs.set('page', params.page.toString());
  if (params.page_size) qs.set('page_size', params.page_size.toString());
  return hitlFetch<HitlSessionsResponse>(`/hitl/sessions?${qs}`, token);
}

export async function getHitlSession(
  conversationId: string,
  token: string,
): Promise<HitlSession> {
  return hitlFetch<HitlSession>(
    `/hitl/sessions/${encodeURIComponent(conversationId)}`,
    token,
  );
}

// ── State transitions ───────────────────────────────────────────────

export async function acceptHitlSession(
  conversationId: string,
  token: string,
): Promise<HitlSession> {
  return hitlFetch<HitlSession>('/hitl/accept', token, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId }),
  });
}

export async function endHitlSession(
  conversationId: string,
  token: string,
): Promise<HitlSession> {
  return hitlFetch<HitlSession>('/hitl/end', token, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId }),
  });
}

// ── Messaging ───────────────────────────────────────────────────────

export async function sendHitlMessage(
  conversationId: string,
  content: string,
  token: string,
): Promise<HitlSession> {
  return hitlFetch<HitlSession>('/hitl/message', token, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId, content }),
  });
}
