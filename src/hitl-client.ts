/**
 * HTTP client for the HITL CRUD backend API.
 * Every call forwards the caller's JWT so the backend can authorise
 * and identify the user / CS agent.
 */
import { config } from './config';
import type { HitlSession, HitlQueueResponse, HitlSessionsResponse } from './types';

const CRUD_TOKEN =
  'eyJhbGciOiJIUzI1NiIsImtpZCI6IndjWDBiOE9sbXZjWitKdjkiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL2ptenl5cW5veWR5c21lY2Fvbm9kLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJlMjM4OTUxZS1kNWFlLTQyMWYtYjcxYi0yODRkMGUzMzBjODQiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzcxNTg2MzAzLCJpYXQiOjE3NzE1ODI3MDMsImVtYWlsIjoiaXRfZXhlY3V0aXZlQGNvbHl0aWNzLmluIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJlbWFpbCIsInByb3ZpZGVycyI6WyJlbWFpbCJdfSwidXNlcl9tZXRhZGF0YSI6eyJlbWFpbF92ZXJpZmllZCI6dHJ1ZX0sInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiYWFsIjoiYWFsMSIsImFtciI6W3sibWV0aG9kIjoicGFzc3dvcmQiLCJ0aW1lc3RhbXAiOjE3NzE1ODI3MDN9XSwic2Vzc2lvbl9pZCI6ImU5OGI2NzBiLWU3OGItNGE5Ny05Mjk5LTNlMjBhZjdmYzBmOSIsImlzX2Fub255bW91cyI6ZmFsc2V9.AP3TjPFCX-MQLJV5REq_qlVY8JpIXCl56rLsifIGzrY';

async function hitlFetch<T>(
  path: string,
  _token: string,
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
        Authorization: `Bearer ${CRUD_TOKEN}`,
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
