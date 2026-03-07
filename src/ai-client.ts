/**
 * HTTP client for the AI agent API.
 * Calls either:
 *  - POST {AI_SERVER_ADDRESS}/tester/chat (JSON)
 *  - POST {AI_SERVER_ADDRESS}/tester/chat/stream (SSE)
 */
import { config } from './config';
import type { AiChatRequest, AiChatResponse } from './types';

interface AiSseEvent {
  event: string;
  data: unknown;
  rawData: string;
}

interface ChatWithAiStreamOptions {
  signal?: AbortSignal;
  onEvent?: (event: AiSseEvent) => void;
}
const SSE_EVENT_NAME_PATTERN = /^[A-Za-z0-9_:-]{1,64}$/;

function buildAiRequestBody(request: AiChatRequest): Record<string, unknown> {
  // Merge profile_id (Supabase user id) into extra_data for tools like human_transfer
  return {
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
}

function createTimeoutController(): {
  controller: AbortController;
  timeout: NodeJS.Timeout;
  hasTimedOut: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    config.aiRequestTimeoutMs
  );
  return { controller, timeout, hasTimedOut: () => timedOut };
}

function parseJsonMaybe(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeDonePayload(payload: unknown): AiChatResponse {
  const done = (payload ?? {}) as Record<string, unknown>;
  return {
    response: String(done.response ?? ''),
    type: String(done.type ?? 'text'),
    action_triggered: Boolean(
      done.action_triggered ?? done.tool_triggered ?? false
    ),
    collecting_params: Boolean(done.collecting_params ?? false),
    missing_params: Array.isArray(done.missing_params)
      ? (done.missing_params as string[])
      : [],
    collected_params:
      done.collected_params && typeof done.collected_params === 'object'
        ? (done.collected_params as Record<string, unknown>)
        : {},
    handoff:
      typeof done.handoff === 'boolean' || typeof done.handoff === 'string'
        ? done.handoff
        : false,
    handoff_reason:
      typeof done.handoff_reason === 'string' || done.handoff_reason === null
        ? done.handoff_reason
        : null,
    url: typeof done.url === 'string' || done.url === null ? done.url : null,
    items: done.items ?? null,
    item_images: done.item_images ?? null,
    ticket_number:
      typeof done.ticket_number === 'string' || done.ticket_number === null
        ? done.ticket_number
        : null,
    hitl_requested: done.hitl_requested ?? null,
    error: typeof done.error === 'string' || done.error === null ? done.error : null,
  };
}

function throwAiNetworkError(url: string, err: unknown): never {
  if (err instanceof DOMException && err.name === 'AbortError') {
    throw new Error('AI API request timed out');
  }
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
}

export async function chatWithAi(
  request: AiChatRequest
): Promise<AiChatResponse> {
  const url = `${config.aiServerAddress}/tester/chat`;
  const { controller, timeout, hasTimedOut } = createTimeoutController();
  const body = buildAiRequestBody(request);

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
    if (err instanceof DOMException && err.name === 'AbortError' && hasTimedOut()) {
      throw new Error('AI API request timed out');
    }
    throwAiNetworkError(url, err);
  } finally {
    clearTimeout(timeout);
  }
}

export async function chatWithAiStream(
  request: AiChatRequest,
  options: ChatWithAiStreamOptions = {}
): Promise<AiChatResponse> {
  const url = `${config.aiServerAddress}/tester/chat/stream`;
  const { controller, timeout, hasTimedOut } = createTimeoutController();
  const body = buildAiRequestBody(request);
  const userAbortSignal = options.signal;
  let onUserAbort: (() => void) | undefined;

  if (userAbortSignal) {
    if (userAbortSignal.aborted) {
      controller.abort();
    } else {
      onUserAbort = () => controller.abort();
      userAbortSignal.addEventListener('abort', onUserAbort, { once: true });
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      throw new Error(`AI API returned ${res.status}: ${responseText}`);
    }
    if (!res.body) {
      throw new Error('AI stream response body is empty');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = 'message';
    let dataLines: string[] = [];
    let donePayload: AiChatResponse | null = null;

    const emitEvent = (): void => {
      if (dataLines.length === 0) {
        eventName = 'message';
        return;
      }

      const rawData = dataLines.join('\n');
      if (rawData.length > config.aiSseMaxEventBytes) {
        throw new Error(
          `AI stream event exceeded ${config.aiSseMaxEventBytes} bytes`
        );
      }
      const parsedData = parseJsonMaybe(rawData);
      const safeEventName =
        eventName && SSE_EVENT_NAME_PATTERN.test(eventName)
          ? eventName
          : 'message';
      const event: AiSseEvent = {
        event: safeEventName,
        data: parsedData,
        rawData,
      };

      options.onEvent?.(event);

      if (event.event === 'error') {
        const errorObject =
          parsedData && typeof parsedData === 'object'
            ? (parsedData as Record<string, unknown>)
            : null;
        const message =
          typeof errorObject?.message === 'string'
            ? errorObject.message
            : 'AI stream returned an error event';
        throw new Error(message);
      }

      if (event.event === 'done') {
        donePayload = normalizeDonePayload(parsedData);
      }

      eventName = 'message';
      dataLines = [];
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > config.aiSseMaxBufferBytes) {
        throw new Error(
          `AI stream buffer exceeded ${config.aiSseMaxBufferBytes} bytes`
        );
      }

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          emitEvent();
          newlineIndex = buffer.indexOf('\n');
          continue;
        }
        if (line.startsWith(':')) {
          newlineIndex = buffer.indexOf('\n');
          continue;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          newlineIndex = buffer.indexOf('\n');
          continue;
        }
        if (line.startsWith('data:')) {
          const valuePart = line.slice(5);
          dataLines.push(
            valuePart.startsWith(' ') ? valuePart.slice(1) : valuePart
          );
          newlineIndex = buffer.indexOf('\n');
          continue;
        }
        // Unknown field (id:, retry:, etc.) is safely ignored.
        newlineIndex = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      let tail = buffer;
      if (tail.endsWith('\r')) tail = tail.slice(0, -1);
      if (tail.startsWith('data:')) {
        const valuePart = tail.slice(5);
        dataLines.push(valuePart.startsWith(' ') ? valuePart.slice(1) : valuePart);
      } else if (tail.startsWith('event:')) {
        eventName = tail.slice(6).trim();
      }
    }
    if (dataLines.length > 0) {
      emitEvent();
    }

    if (!donePayload) {
      throw new Error('AI stream ended without done event');
    }
    console.log('[AI Stream Done]', JSON.stringify(donePayload, null, 2));
    return donePayload;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (hasTimedOut()) throw new Error('AI API request timed out');
      throw new Error('AI API request aborted');
    }
    throwAiNetworkError(url, err);
    throw new Error('Unexpected AI stream failure');
  } finally {
    if (onUserAbort && userAbortSignal) {
      userAbortSignal.removeEventListener('abort', onUserAbort);
    }
    clearTimeout(timeout);
  }
}
