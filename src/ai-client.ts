/**
 * HTTP client for the AI agent API.
 * Calls POST {AI_SERVER_ADDRESS}/tester/chat
 */
import { config } from './config';
import type { AiChatRequest, AiChatResponse } from './types';

export async function chatWithAi(
  request: AiChatRequest
): Promise<AiChatResponse> {
  const url = `${config.aiServerAddress}/tester/chat`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.aiRequestTimeoutMs
  );

  // Merge profile_id (Supabase user id) into extra_data for tools like human_transfer
  const body = {
    user_input: request.user_input,
    conversation_history: request.conversation_history,
    chat_agent_id: request.chat_agent_id,
    conversation_id: request.conversation_id,
    extra_data: {
      ...(request.extra_data ?? {}),
      ...(request.profile_id && {
        profile_id: request.profile_id,
        user_profile_id: request.profile_id,
      }),
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI API returned ${res.status}: ${body}`);
    }

    const data = (await res.json()) as AiChatResponse;
    console.log('[AI Response]', JSON.stringify(data, null, 2));
    return data;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('AI API request timed out');
    }
    // Rethrow our own HTTP error (from !res.ok)
    if (err instanceof Error && err.message.startsWith('AI API returned')) {
      throw err;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    const cause = (e as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : e.message;
    throw new Error(
      `AI API unreachable (${url}): ${detail}. ` +
      'For local dev, set AI_SERVER_ADDRESS=http://localhost:8001 and run zoft_conversational_agent.'
    );
  } finally {
    clearTimeout(timeout);
  }
}
