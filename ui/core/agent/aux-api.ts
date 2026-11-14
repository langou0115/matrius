import type { ModelConfig } from '../../../contract/agent-protocol';

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

/** Optional side request: title failures keep the locally derived fallback. */
export async function requestConversationTitle({
  config,
  apiKey,
  content,
  quote,
  signal,
}: {
  config: ModelConfig;
  apiKey: string;
  content: string;
  quote?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const result = await post<{ title: string | null }>('/api/agent/title', {
    model: config,
    ...(apiKey ? { apiKey } : {}),
    content,
    ...(quote ? { quote } : {}),
  }, signal);
  return result?.title ?? null;
}

/** Optional background consolidation: a failure leaves the stored memory untouched. */
export async function requestMemorySummary({
  config,
  apiKey,
  currentSummary,
  userMessage,
  assistantMessage,
  instruction,
  signal,
}: {
  config: ModelConfig;
  apiKey: string;
  currentSummary: string;
  userMessage: string;
  assistantMessage: string;
  instruction?: boolean;
  signal?: AbortSignal;
}): Promise<string | null> {
  const result = await post<{ summary: string | null }>('/api/agent/memory', {
    model: config,
    ...(apiKey ? { apiKey } : {}),
    currentSummary,
    userMessage,
    assistantMessage,
    instruction,
  }, signal);
  return result?.summary ?? null;
}
