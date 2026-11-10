import type { ModelConfig } from '@/core/llm/model-config';

/**
 * Auxiliary model calls (title and memory consolidation) run inside the agent service like
 * the main loop, so the browser never talks to a provider. Failures stay silent: both are
 * enhancements on top of a finished reply.
 */

async function post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error('agent_request_failed');
  return await response.json() as T;
}

export async function requestConversationTitle({ config, apiKey, content, quote, signal }: {
  config: ModelConfig; apiKey: string; content: string; quote?: string; signal?: AbortSignal;
}): Promise<string | null> {
  try {
    const data = await post<{ title?: unknown }>('/api/agent/title', { config, apiKey, content, quote }, signal);
    return typeof data.title === 'string' && data.title.trim() ? data.title : null;
  } catch {
    return null;
  }
}

export async function requestMemorySummary({ config, apiKey, currentSummary, userMessage, assistantMessage, signal }: {
  config: ModelConfig; apiKey: string; currentSummary: string;
  userMessage: string; assistantMessage: string; signal?: AbortSignal;
}): Promise<string | null> {
  try {
    const data = await post<{ summary?: unknown }>('/api/agent/memory', {
      config, apiKey, currentSummary, userMessage, assistantMessage,
    }, signal);
    return typeof data.summary === 'string' ? data.summary : null;
  } catch {
    return null;
  }
}
