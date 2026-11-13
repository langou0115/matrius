import type { StreamFn } from '@mariozechner/pi-agent-core';

/** Protocol transport only. Agent lifecycle and conversation state belong to core/agent. */
export const directStream: StreamFn = async (model, context, options) => {
  if (model.api === 'anthropic-messages') {
    const { streamSimpleAnthropic } = await import('@mariozechner/pi-ai/anthropic');
    return streamSimpleAnthropic({ ...model, api: 'anthropic-messages' }, context, options);
  }
  if (model.api === 'openai-responses') {
    const { streamSimpleOpenAIResponses } = await import('@mariozechner/pi-ai/openai-responses');
    return streamSimpleOpenAIResponses({ ...model, api: 'openai-responses' }, context, options);
  }
  const { streamSimpleOpenAICompletions } = await import('@mariozechner/pi-ai/openai-completions');
  return streamSimpleOpenAICompletions({ ...model, api: 'openai-completions' }, context, options);
};
